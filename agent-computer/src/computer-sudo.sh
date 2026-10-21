#!/command/with-contenv sh
# 机器人电脑的完整 sudo（默认关闭；docs/computer-sudo.md）。
#
# 镜像默认只允许 pwuser 免密 sudo 包管理器（Dockerfile「A Bot can install what a task needs」那段）：
# 机器人的 shell 和 API、内置数据库在同一个容器里，root 能读到 API 的环境变量（KEY_ENCRYPTION_KEY）、
# 模型密钥和审计库。单用户的个人部署可以自己决定接受这个风险：在 deploy/.env 设
# CHISABOT_COMPUTER_SUDO=full 并重建容器，机器人在自己的电脑（容器）里就是 root。
# 它仍然碰不到宿主机：容器之外的 docker、systemd、SSH、证书都不受影响。
#
# 每次容器启动由 s6 以 root 运行（/etc/cont-init.d），开 / 关都在这里落定：不是 full 就删掉授权文件，
# 关掉开关后重建容器即回到受限状态。放在 agent-computer/src 下，是因为三种镜像（Dockerfile、
# deploy/Dockerfile.zh、一键更新的 Dockerfile.update）都会带上这个目录。
set -eu

grant=/etc/sudoers.d/zz-chisabot-computer-full

case "${CHISABOT_COMPUTER_SUDO:-off}" in
  full)
    if ! command -v visudo >/dev/null 2>&1; then
      echo "[computer-sudo] 镜像里没有 sudo，保持受限。" >&2
      exit 0
    fi
    tmp=$(mktemp)
    printf '%s\n' 'pwuser ALL=(ALL) NOPASSWD: ALL' > "$tmp"
    chmod 0440 "$tmp"
    if visudo -cf "$tmp" >/dev/null 2>&1; then
      mv "$tmp" "$grant"
      echo "[computer-sudo] CHISABOT_COMPUTER_SUDO=full：机器人电脑已开启完整 sudo（容器内 root）。"
    else
      rm -f "$tmp"
      echo "[computer-sudo] sudoers 校验失败，保持受限。" >&2
    fi
    ;;
  *)
    rm -f "$grant"
    ;;
esac
