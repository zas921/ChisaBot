import { z } from "zod";
import {
  PanelError,
  type ActorContext,
  type CommitInput,
  type DraftWrite,
} from "../../../shared/panels/types";
import { validatePanelDefinition } from "../../../shared/panels/validate";
import type { GrantedTool } from "../plugins/tools";
import type { PanelStore } from "./store";
const schema = z.record(z.string(), z.unknown());
const capability = z
  .object({
    id: z.string(),
    adapter: z.string(),
    action: z.string(),
    inputSchema: schema,
    outputSchema: schema,
    scope: schema,
    effect: z.enum(["read", "write"]),
  })
  .strict();
/*
 * 模型写的定义里最容易漏 / 写偏的是这些「有合理默认值」的字段：以前一个都不能少、多一个键也不行，
 * 校验失败只回一个裸的错误码（`invalid_definition`），模型不知道错在哪，十二步重试都耗在盲改上，
 * 面板就「写不出来」（2026-10-21 / 22 用户反复反馈）。现在：有默认值的字段可以省略；尺寸越界在 execute 里夹回范围；
 * 多余的键直接丢掉；真正不能猜的（name / html，以及安全检查）仍然必须对，并且报错会说清楚怎么改。
 */
const EMPTY_STATE_SCHEMA = { type: "object", properties: {} } as const;
const definitionSchema = z.object({
  name: z.string().min(1).max(80),
  html: z.string(),
  css: z.string().default(""),
  script: z.string().default(""),
  manifest: z
    .object({ data: z.array(capability).default([]), tasks: z.array(capability).default([]) })
    .default({ data: [], tasks: [] }),
  stateSchema: schema.default({ ...EMPTY_STATE_SCHEMA }),
  schemaVersion: z.number().int().positive().default(1),
  initialState: z.unknown().default({}),
  size: z
    .object({
      width: z.number().describe("280–600，默认 340"),
      height: z.union([z.literal("auto"), z.number()]).describe("auto，或 160–960 的数字"),
    })
    .default({ width: 340, height: "auto" }),
});
const parameters = z.object({
  expectedDraftRevision: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("上次返回的 draftRevision；首次为 0。填错了也没关系，服务器会按当前草稿修订处理"),
  definition: definitionSchema,
});

/** 把夹得回来的数值夹回允许范围（宽 280–600、高 160–960），其余不动。 */
export function clampPanelSize<T extends { size: { width: number; height: "auto" | number } }>(definition: T): T {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const { width, height } = definition.size;
  return {
    ...definition,
    size: {
      width: Number.isFinite(width) ? clamp(width, 280, 600) : 340,
      height: height === "auto" ? "auto" : Number.isFinite(height) ? clamp(height, 160, 960) : "auto",
    },
  };
}

/** 校验错误码 → 模型能照着改的一句话（`PanelError.message` 会带上它）。 */
const PANEL_HINTS: Record<string, string> = {
  invalid_definition:
    "definition 只能有 name / html / css / script / manifest / stateSchema / schemaVersion / initialState / size 这几个键；name 非空且不超过 80 字，html / css / script 都是字符串（没有就给空字符串）",
  invalid_size: "size.width 要在 280–600 之间，size.height 是 'auto' 或 160–960 的数字",
  invalid_manifest: "manifest 必须是 {data:[],tasks:[]}（不需要能力就两个都给空数组，总数不超过 32）",
  invalid_capability:
    "manifest 里每项能力只能有 id / adapter / action / inputSchema / outputSchema / scope / effect，id 以字母开头只含字母数字 _ -，data 里的 effect 只能是 read",
  invalid_data_effect: "manifest.data 里只能放 effect 为 'read' 的能力；会写东西的放进 manifest.tasks",
  invalid_state_schema:
    "stateSchema 每一层都必须有 type（object 要有 properties），数组要有 items；不需要状态就用 {type:'object',properties:{}} 并让 initialState 为 {}",
  unsupported_state_schema:
    "stateSchema 每一层都必须有 type（object 要有 properties，数组要有 items）；只支持 type / properties / required / additionalProperties / items / enum / const / minimum / maximum / minLength / maxLength / minItems / maxItems / title / description，别的关键字不行",
  invalid_initial_state: "initialState 必须符合 stateSchema（类型、必填项、范围都要对得上）",
  invalid_css: "css 只能是普通规则：类选择器 + 属性，不能有 @规则、url()、animation、filter，也不能有语法错误",
  unsafe_css: "css 里有被禁止的写法：@规则、url()、animation、filter、expression 等都不行；只用颜色 / 间距 / 字号 / 布局这类属性",
  unsafe_css_selector:
    "css 选择器只能是类选择器（.xxx）；伪类只允许 hover / focus / focus-visible / focus-within / disabled / checked / first-child / last-child / root，不能写标签、id、属性选择器",
  css_limit: "css 太长，精简一下",
  css_rule_limit: "css 规则太多，合并或删掉一些",
  css_selector_limit: "css 选择器太多，合并或删掉一些",
  unsafe_view_tag: "html 里有不允许的标签：不能有 script / iframe / style / link / form 等，只用 div / span / p / h1-h4 / ul / li / button / main 等安全标签",
  unsafe_view_attr: "html 里有不允许的属性：不能有事件属性（onclick 等）、href / src 指向外部；按钮用 data-action，要被脚本改的节点用 data-node",
  invalid_node_id: "data-node 只能是字母开头的字母数字 _ -，且在整个 html 里不能重复",
  invalid_view_attrs: "html 的属性写法不对（属性值要是普通字符串）",
  external_image_refused: "html 里不能引用外部图片；用文字、emoji 或 CSS 画",
  external_svg_refused: "html 里的 svg 不能引用外部资源",
  unsafe_input_type: "input 的 type 不被允许，用 text / number / checkbox 这类普通类型",
  unsafe_tabindex: "tabindex 只能是 0 或 -1",
  invalid_view_tree: "html 结构有问题（标签没闭合或嵌套不对）",
  invalid_text_node: "html 里有不合法的文字内容",
  view_depth_limit: "html 嵌套太深（不超过 32 层）",
  view_limit: "html 节点太多（不超过 2000 个），精简一下",
  json_limit: "initialState / stateSchema 的 JSON 太大或嵌套太深，精简一下",
  invalid_json: "initialState / stateSchema 里有不能表示成 JSON 的值",
};

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "(根)"}：${issue.message}`)
    .join("；");
}

/** 把校验抛出的裸错误码补上「错在哪、怎么改」，其余错误原样抛出。 */
export function explained(error: unknown): never {
  if (error instanceof PanelError) {
    const hint = PANEL_HINTS[error.code];
    if (hint && error.message === error.code) throw new PanelError(error.code, error.status, hint);
    throw error;
  }
  if (error instanceof z.ZodError)
    throw new PanelError("invalid_definition", 400, `参数不对：${zodMessage(error)}。${PANEL_HINTS.invalid_definition}`);
  throw error;
}
export function createPanelAuthoring(options: {
  store: PanelStore;
  authorize(ctx: ActorContext, manage: boolean): Promise<void>;
  audit?: (event: Record<string, unknown>) => Promise<void>;
}) {
  const ctxCopy = (ctx: ActorContext) => Object.freeze({ ...ctx });
  async function authorize(ctx: ActorContext, manage = true) {
    if (!ctx.actorId || !ctx.botId)
      throw new PanelError("unauthenticated", 401);
    try {
      await options.authorize(ctx, manage);
    } catch (error) {
      if (error instanceof PanelError) throw error;
      throw new PanelError("panel_permission_refused", 403);
    }
  }
  async function record(ctx: ActorContext, operation: string, id?: string) {
    await options.audit?.({
      actorId: ctx.actorId,
      botId: ctx.botId,
      operation,
      ...(id ? { resourceId: id } : {}),
    });
  }
  async function save(ctx: ActorContext, input: DraftWrite) {
    await authorize(ctx);
    const definition = validatePanelDefinition(input.definition);
    await options.store.getSession(ctx, input.sessionId);
    await record(ctx, "draft", input.sessionId);
    return options.store.saveDraft(ctx, { ...input, definition });
  }
  return {
    authorize,
    async beginPanelAuthoring(ctx: ActorContext, targetInstanceId?: string) {
      await authorize(ctx);
      await record(ctx, "begin", targetInstanceId);
      return options.store.beginSession(ctx, targetInstanceId);
    },
    proposePanelDraft: save,
    revisePanelDraft: save,
    async commit(ctx: ActorContext, input: CommitInput) {
      await authorize(ctx);
      await record(ctx, "commit", input.draftId);
      return options.store.commit(ctx, input);
    },
    async tools(
      ctx: ActorContext,
      sessionId: string,
    ): Promise<readonly GrantedTool[]> {
      ctx = ctxCopy(ctx);
      await authorize(ctx);
      const session = await options.store.getSession(ctx, sessionId);
      if (session.draft?.status === "saved") return [];
      const source =
        session.draft?.definition ??
        (session.targetInstanceId
          ? (await options.store.getInstance(ctx, session.targetInstanceId))
              .definition
          : null);
      const context = source
        ? `当前完整定义（仅样例初始状态，不含用户私有状态），草稿修订 ${session.draft?.draftRevision ?? 0}: ${JSON.stringify(source)}`
        : "新面板会话，首次提交 expectedDraftRevision 为 0。";
      return ["proposePanelDraft", "revisePanelDraft"].map((name) => ({
        name,
        ref: `panel:${name}`,
        parameters,
        description: `${name === "proposePanelDraft" ? "创建" : "修改"}面板并保存到右侧面板栏（不授权能力、不执行任务）。用户此刻正在右栏「新建 / 编辑面板」：用户要的面板必须用这个工具保存（不要用 render_ui 在对话里画，那不会出现在面板栏）；工具会直接把面板放进右侧面板栏，之后在对话里只用一句话确认。面板脚本里需要日期、时间时用 new Date() 实时计算，不要写死。一次写对（校验失败不产生修订，重试仍用同一个 expectedDraftRevision；不要在对话里逐条报告重试）：stateSchema 每一层都必须有 type（object 要有 properties），不需要状态时用 {type:'object',properties:{}} 和 initialState {}；CSS 只用类选择器，伪类只允许 hover/focus/focus-visible/focus-within/disabled/checked/first-child/last-child/root，禁止 @规则、url()、animation、filter；不需要能力时 manifest 为 {data:[],tasks:[]}。${context} definition 必填 name 和 html；css/script/manifest/stateSchema/schemaVersion/initialState/size 不写就取默认值（空 css、空 script、{data:[],tasks:[]}、空对象状态、1、{}、宽 340 自动高）。校验不通过时报错会写明哪里不对、怎么改，照改后重新调用（草稿修订服务器会按当前的算，不用操心数字）。HTML 禁止 script、iframe、事件属性和联网；安全标签使用 data-node，按钮使用 data-action。脚本仅使用 panel.on(action,async event=>{}), panel.ui.patch([{node,text,attrs,children}]), panel.state.read/write, panel.data.read(id,args), panel.tasks.request(id,args)；无 DOM、网络、浏览器存储或模块。预览仅运行示例数据与临时状态。首次 expectedDraftRevision=0，后续使用上次返回的 draftRevision。中文简洁右栏，宽340，自动高。固定能力 bot/overview read: inputSchema={type:'object',additionalProperties:false}, outputSchema={type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}; bot/task write: inputSchema={type:'object',properties:{instruction:{type:'string',minLength:1,maxLength:5000}},required:['instruction'],additionalProperties:false}, outputSchema={type:'object',additionalProperties:false}; scope={actor:'current',bot:'current'}。manifest 仅申请，保存后用户单独批准。状态 schema 仅支持 type/properties/required/additionalProperties/items/enum/const/minimum/maximum/minLength/maxLength/minItems/maxItems/title/description。`,
        execute: async (args: unknown) => {
          let input: z.output<typeof parameters>;
          try {
            input = parameters.parse(args);
          } catch (error) {
            return explained(error);
          }
          // 草稿修订以服务器上当前的为准：模型常把「首次 0 / 之后用返回值」记错，或者提交时选错 propose / revise。
          // 这里没有第二个写入者（草稿只由这条对话里的机器人写），按当前修订写就是它想要的结果，不再为数字对不上整轮重来。
          const current = (await options.store.getSession(ctx, sessionId)).draft;
          if (current?.status === "saved")
            throw new PanelError("draft_revision_conflict", 409, "这份草稿已经保存进面板栏了；要再改请让用户在右栏点这张面板的「编辑」");
          let draft: Awaited<ReturnType<typeof save>>;
          try {
            draft = await save(ctx, {
              sessionId,
              expectedDraftRevision: current?.draftRevision ?? 0,
              definition: validatePanelDefinition(clampPanelSize(input.definition)),
            });
          } catch (error) {
            return explained(error);
          }
          // 创作会话只能由用户开启（右栏「新建 / 编辑」或在对话里明确要一个面板），所以这是用户
          // 明确要的面板：直接保存进面板栏（用户可在卡片上撤销 / 删除），不再停在「预览并保存」。
          // 保存不了（例如需要重置状态）时退回草稿，请用户在右栏预览后保存。
          try {
            const saved = await options.store.commit(ctx, {
              draftId: draft.id,
              expectedDraftRevision: draft.draftRevision,
              mode: draft.targetInstanceId ? "instance" : "first",
              idempotencyKey: crypto.randomUUID(),
              resetState: false,
              ...(draft.baseInstanceVersion !== null
                ? { baseInstanceVersion: draft.baseInstanceVersion }
                : {}),
              ...(draft.baseLibraryVersion !== null
                ? { baseLibraryVersion: draft.baseLibraryVersion }
                : {}),
            });
            await record(ctx, "commit", draft.id);
            return JSON.stringify({
              status: "saved",
              instanceId: saved.instanceId,
              note: "面板已保存到右侧面板栏。对话里只用一句话告诉用户已经放好，不要再贴面板内容。",
            });
          } catch (error) {
            return JSON.stringify({
              draftId: draft.id,
              draftRevision: draft.draftRevision,
              status: draft.status,
              note: `草稿已保存，但没能自动放进面板栏（${error instanceof Error ? error.message : "未知原因"}）。请用户在右栏点「预览与保存」。`,
            });
          }
        },
      }));
    },
  };
}
export type PanelAuthoring = ReturnType<typeof createPanelAuthoring>;
