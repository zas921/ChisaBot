import { type BaseEvent, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";

/**
 * The model can end while still streaming a tool's input, e.g. on truncation or
 * a provider transport failure. AG-UI accepts RUN_ERROR in that state, but it
 * rejects RUN_FINISHED. Never invent TOOL_CALL_END: partial input is not a
 * completed call, even if it happens to parse as JSON.
 */
export function guardToolCallStream(
  source: Observable<BaseEvent>,
  stopped: () => boolean = () => false,
): Observable<BaseEvent> {
  return new Observable((out) => {
    const open = new Set<string>();
    let terminal = false;

    const failIncomplete = (ending: "run-finished" | "eof") => {
      terminal = true;
      if (!stopped()) {
        console.warn(JSON.stringify({ type: "model-tool-arguments-incomplete", ending, openCalls: open.size }));
        out.next({
          type: EventType.RUN_ERROR,
          code: "INCOMPLETE_TOOL_CALL",
          message: "模型在工具参数尚未传完时结束了输出，这次工具调用未能继续。已完成的步骤仍保留。",
        });
      }
      out.complete();
    };

    return source.subscribe({
      next(event) {
        if (terminal || out.closed) return;
        if (event.type === EventType.TOOL_CALL_START) open.add(event.toolCallId);
        if (event.type === EventType.TOOL_CALL_END) open.delete(event.toolCallId);
        if (event.type === EventType.RUN_FINISHED) {
          if (open.size) {
            failIncomplete("run-finished");
            return;
          }
          terminal = true;
        } else if (event.type === EventType.RUN_ERROR) terminal = true;
        out.next(event);
      },
      error(error) { out.error(error); },
      complete() {
        if (!terminal && open.size) failIncomplete("eof");
        else out.complete();
      },
    });
  });
}
