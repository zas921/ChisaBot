#!/usr/bin/env python3
"""Host-only transactional Magpie updates. Requires Python 3.6+, Docker and buildx.

Clones the actual running configuration, so Compose and manual containers both work.
Public state/logs never include container inspection data or upstream response bodies.
"""
import argparse
import copy
import datetime
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def file_digest(path):
    digest = hashlib.sha256()
    with open(str(path), "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value, mode=0o600):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".magpie-", dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, str(path))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class Failure(Exception):
    pass


class DockerError(Failure):
    def __init__(self, status):
        self.status = status
        super().__init__("Docker API 返回 HTTP %s" % status)


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=60)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def command(args, timeout=60):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Failure("操作超时；请稍后重试")
    if result.returncode:
        raise Failure("%s 操作失败，请检查宿主机网络和服务状态" % args[0])
    return result.stdout


class Docker:
    def api(self, method, path, data=None):
        conn = UnixHTTP()
        try:
            conn.request(method, path, None if data is None else json.dumps(data).encode(),
                         {"Content-Type": "application/json"})
            response = conn.getresponse()
            raw = response.read()
            if response.status >= 300 and response.status != 304:
                raise DockerError(response.status)
            return json.loads(raw) if raw else None
        finally:
            conn.close()

    def inspect(self, name):
        try:
            return self.api("GET", "/containers/" + urllib.parse.quote(name, safe="") + "/json")
        except DockerError as error:
            if error.status == 404:
                return None
            raise

    def image(self, name):
        return self.api("GET", "/images/" + urllib.parse.quote(name, safe="") + "/json")

    def pull(self, image):
        command(["docker", "pull", image], timeout=600)
        return self.image(image)["Id"]

    def stop(self, ident):
        self.api("POST", "/containers/%s/stop?t=20" % ident)

    def start(self, ident):
        self.api("POST", "/containers/%s/start" % ident)

    def rename(self, ident, name):
        self.api("POST", "/containers/%s/rename?name=%s" % (ident, urllib.parse.quote(name)))

    def remove(self, ident):
        self.api("DELETE", "/containers/%s?force=true" % ident)

    def disconnect(self, network, ident):
        self.api("POST", "/networks/%s/disconnect" % urllib.parse.quote(network, safe=""),
                 {"Container": ident, "Force": True})

    def connect(self, network, ident, endpoint):
        self.api("POST", "/networks/%s/connect" % urllib.parse.quote(network, safe=""),
                 {"Container": ident, "EndpointConfig": endpoint})

    def create(self, name, config):
        return self.api("POST", "/containers/create?name=" + urllib.parse.quote(name), config)["Id"]


def endpoint_config(endpoint):
    return {k: copy.deepcopy(endpoint[k]) for k in ("Aliases", "IPAMConfig", "DriverOpts")
            if endpoint.get(k) is not None}


def replacement_config(old, image, job):
    config = copy.deepcopy(old["Config"])
    config["Image"] = image
    config["Labels"] = dict(config.get("Labels") or {}, **{"chisabot.magpie.update": job})
    host = copy.deepcopy(old["HostConfig"])
    covered = {m.get("Target") for m in host.get("Mounts") or []}
    covered.update(b.rsplit(":", 2)[-2] if b.count(":") >= 2 else b.split(":")[-1]
                   for b in host.get("Binds") or [])
    for mount in old.get("Mounts", []):
        if mount["Type"] in ("bind", "volume") and mount["Destination"] not in covered:
            if not host.get("Binds"):
                host["Binds"] = []
            source = mount.get("Name") if mount["Type"] == "volume" else mount["Source"]
            host["Binds"].append("%s:%s:%s" % (source, mount["Destination"], "rw" if mount["RW"] else "ro"))
    config["HostConfig"] = host
    config["NetworkingConfig"] = {"EndpointsConfig": {
        name: endpoint_config(endpoint) for name, endpoint in old["NetworkSettings"]["Networks"].items()}}
    return config


def remote_image_id(target, platform):
    if DIGEST.fullmatch(target):
        return target
    def manifest(ref):
        try:
            return json.loads(command(["docker", "buildx", "imagetools", "inspect", "--raw", ref], 50))
        except (ValueError, Failure):
            raise Failure("无法读取镜像仓库摘要；当前版本保持运行")
    data = manifest(target)
    if "manifests" in data:
        variants = [m for m in data["manifests"] if
                    m.get("platform", {}).get("os") == platform[0] and
                    m.get("platform", {}).get("architecture") == platform[1] and
                    (not platform[2] or m.get("platform", {}).get("variant") == platform[2])]
        if not variants:
            raise Failure("新镜像没有此服务器架构的版本")
        digest = variants[0].get("digest", "")
        if not DIGEST.fullmatch(digest):
            raise Failure("镜像仓库返回的摘要无效")
        data = manifest(target.split("@", 1)[0] + "@" + digest)
    digest = data.get("config", {}).get("digest", "")
    if not DIGEST.fullmatch(digest):
        raise Failure("镜像仓库返回的配置摘要无效")
    return digest


class Updater:
    def __init__(self, env=None, docker=None):
        self.env = dict(os.environ if env is None else env)
        self.home = pathlib.Path(self.env.get("CHISABOT_UPDATER_DIR", "/opt/chisabot-updater"))
        self.container = self.env.get("MAGPIE_CONTAINER", "magpie")
        self.target = self.env.get("MAGPIE_IMAGE", "ghcr.io/yetone/magpie:latest")
        self.state = self.home / "spool/state/magpie.json"
        self.journal = self.home / "magpie-transaction.json"
        self.docker = docker or Docker()

    def report(self, current=None, latest=None, error=None):
        value = {"installed": current is not None, "image": self.target, "container": self.container,
                 "currentDigest": current, "latestDigest": latest,
                 "updateAvailable": bool(current and latest and current != latest), "checkedAt": stamp()}
        if error:
            value["error"] = error
        write_json(self.state, value, 0o644)
        return value

    def check(self):
        old = self.docker.inspect(self.container)
        try:
            if not old:
                raise Failure("Magpie 尚未安装；请先部署模型网关")
            image = self.docker.image(old["Image"])
            latest = remote_image_id(self.target, (image["Os"], image["Architecture"], image.get("Variant")))
            return self.report(old["Image"], latest)
        except Failure as error:
            return self.report(old["Image"] if old else None, error=str(error))

    def data_directory(self, old):
        matches = [m for m in old.get("Mounts", []) if m["Destination"] == "/config" and m.get("RW")]
        if len(matches) != 1:
            raise Failure("需要可写的 /config 持久化挂载；更新未开始")
        path = pathlib.Path(matches[0]["Source"]).resolve()
        if not path.is_dir() or len(path.parts) < 3 or str(path) in ("/etc", "/usr", "/var", "/opt", "/root", "/home"):
            raise Failure("Magpie 数据挂载路径不安全；更新未开始")
        return path

    def rollback(self, journal):
        old = json.loads((pathlib.Path(journal["backup"]) / "container.json").read_text())
        current = self.docker.inspect(self.container)
        if current and current["Id"] != old["Id"]:
            if (current["Config"].get("Labels") or {}).get("chisabot.magpie.update") != journal["job"]:
                raise Failure("发现其他操作创建的容器，拒绝覆盖；请人工恢复备份")
            self.docker.remove(current["Id"])
        elif journal.get("newId") and self.docker.inspect(journal["newId"]):
            self.docker.remove(journal["newId"])
        if journal.get("newStarted"):
            source = self.data_directory(old)
            archive = pathlib.Path(journal["backup"]) / "config.tar.gz"
            if not archive.is_file():
                raise Failure("数据备份缺失，拒绝覆盖现有数据")
            if file_digest(archive) != journal.get("archiveDigest"):
                raise Failure("数据备份校验失败，拒绝覆盖现有数据")
            for child in source.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(str(child))
                else:
                    child.unlink()
            command(["tar", "--numeric-owner", "-xzpf", str(archive), "-C", str(source), "--strip-components=1"], 180)
        if not self.docker.inspect(old["Id"]):
            raise Failure("原容器已丢失，请从备份恢复")
        restored = self.docker.inspect(old["Id"])
        if restored.get("Name") != "/" + self.container:
            self.docker.rename(old["Id"], self.container)
        attached = restored["NetworkSettings"]["Networks"]
        for name, endpoint in old["NetworkSettings"]["Networks"].items():
            if name not in attached:
                self.docker.connect(name, old["Id"], endpoint_config(endpoint))
        self.docker.start(old["Id"])
        if not self.healthy(old):
            raise Failure("原容器已恢复，但健康检查仍失败；请检查宿主机服务状态")
        self.journal.unlink()
        self.report(old["Image"], error="新版本未通过验证，已恢复原容器和数据")

    def probe(self, old):
        env = dict(x.split("=", 1) for x in old["Config"]["Env"])
        key = env.get("MAGPIE_WEB_KEY")
        if not key:
            raise Failure("请先配置固定的 MAGPIE_WEB_KEY，再使用一键更新")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        url = self.env.get("MAGPIE_PROBE_URL", "http://127.0.0.1:3430/")
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port or 80
        headers = {"Host": "localhost:%s" % port, "Cookie": "magpie_web_%s=%s" % (port, key)}
        for path in ("/", "/api/settings", "/api/providers"):
            req = urllib.request.Request(urllib.parse.urljoin(url, path), headers=headers)
            with opener.open(req, timeout=8) as response:
                if response.status != 200:
                    return False
                body = response.read(32 * 1024 * 1024)
                if path != "/":
                    data = json.loads(body)
                    if path.endswith("settings") and data.get("gatewayOn") is not True:
                        return False
                    if path.endswith("providers") and not isinstance(data.get("providers"), list):
                        return False
                elif b"<html" not in body.lower() and b"<!doctype" not in body.lower():
                    return False
        command(["docker", "exec", self.container, "/magpie", "healthcheck"], 12)
        app = self.env.get("MAGPIE_CHISABOT_URL")
        if app:
            req = urllib.request.Request(app.rstrip("/") + "/api/models?refresh=1",
                                         headers={"Host": self.env.get("MAGPIE_CHISABOT_HOST", "localhost:3001")})
            with opener.open(req, timeout=12) as response:
                data = json.load(response)
                if data.get("source") != "magpie" or not isinstance(data.get("models"), list):
                    return False
        return True

    def healthy(self, old):
        deadline = time.monotonic() + int(self.env.get("MAGPIE_HEALTH_TIMEOUT_SEC", "60"))
        while time.monotonic() < deadline:
            try:
                if self.probe(old):
                    return True
            except Exception:
                pass
            time.sleep(2)
        return False

    def update(self, job):
        self.home.mkdir(parents=True, exist_ok=True)
        with open(str(self.home / "update.lock"), "a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure("已有更新或回滚正在进行，请稍后重试")
            return self._update(job)

    def _update(self, job):
        if self.journal.exists():
            pending = json.loads(self.journal.read_text())
            if pending.get("committed"):
                self.journal.unlink()
            else:
                print("恢复上次中断的更新", flush=True)
                self.rollback(pending)
        old = self.docker.inspect(self.container)
        if not old or not old["State"]["Running"]:
            raise Failure("Magpie 容器未运行；请先恢复服务")
        source = self.data_directory(old)
        if not any(e.startswith("MAGPIE_WEB_KEY=") and len(e.split("=", 1)[1]) >= 16 for e in old["Config"]["Env"]):
            raise Failure("请先配置固定的 MAGPIE_WEB_KEY，再使用一键更新")
        print("::step:: prepare\n保留当前代理、密钥、数据挂载及网络配置", flush=True)
        print("::from:: " + old["Image"], flush=True)
        print("::step:: pull\n拉取 Magpie 镜像；完成前不停止当前服务", flush=True)
        latest = self.docker.pull(self.target)
        print("::to:: " + latest, flush=True)
        if latest == old["Image"]:
            self.report(old["Image"], latest)
            print("::step:: done\n当前运行的 Magpie 已是该镜像版本\n::result:: succeeded", flush=True)
            return 0
        backup = self.home / "magpie-backups" / (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8])
        backup.mkdir(parents=True, mode=0o700)
        backup.parent.chmod(0o700)
        write_json(backup / "container.json", old)
        journal = {"job": job, "backup": str(backup), "newStarted": False}
        write_json(self.journal, journal)
        try:
            print("::step:: backup\n短暂停止 Magpie，备份完整配置与登录数据", flush=True)
            self.docker.stop(old["Id"])
            with tarfile.open(str(backup / "config.tar.gz"), "w:gz") as archive:
                os.chmod(str(backup / "config.tar.gz"), 0o600)
                archive.add(str(source), arcname="config")
            journal["archiveDigest"] = file_digest(backup / "config.tar.gz")
            write_json(self.journal, journal)
            print("备份完成：" + str(backup), flush=True)
            self.docker.rename(old["Id"], self.container + "-before-" + backup.name)
            for name in old["NetworkSettings"]["Networks"]:
                self.docker.disconnect(name, old["Id"])
            print("::step:: swap\n按原运行配置创建新版本容器", flush=True)
            journal["newId"] = self.docker.create(self.container, replacement_config(old, latest, job))
            journal["newStarted"] = True
            write_json(self.journal, journal)
            self.docker.start(journal["newId"])
            print("::step:: health\n验证管理页面、提供方接口和模型网关", flush=True)
            if not self.healthy(old):
                raise Failure("新版本未通过管理界面或模型网关验证")
            journal["committed"] = True
            write_json(self.journal, journal)
            self.report(latest, latest)
            self.journal.unlink()
            print("::step:: done\nMagpie 更新成功；原容器与数据备份已保留\n::result:: succeeded", flush=True)
            return 0
        except BaseException:
            print("::step:: rollback\n更新未完成，正在恢复原容器和数据", flush=True)
            self.rollback(json.loads(self.journal.read_text()))
            print("::error:: 更新失败，已自动恢复原版本\n::result:: rolled_back", flush=True)
            return 3


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--update", action="store_true")
    parser.add_argument("--job", default="manual-" + uuid.uuid4().hex[:12])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    updater = Updater()
    started = time.monotonic()
    def interrupted(*unused):
        raise Failure("更新被中断")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        if args.check or args.dry_run:
            print(json.dumps(updater.check()), flush=True)
            return 0
        return updater.update(args.job)
    except Exception as error:
        message = str(error) if isinstance(error, Failure) else "Magpie 更新发生异常，请检查宿主机服务状态"
        print("::error:: " + message + "\n::result:: failed", flush=True)
        return 2
    finally:
        print("::duration:: " + str(int(time.monotonic() - started)), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
