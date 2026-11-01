import type {
  LocalClockPort,
  LocalParticipationPort,
  LocalParticipationSnapshot,
  SharedCursorPosition,
  TaskColorRegistrySnapshot,
} from '@ohif/core';
import type { RemoteCursorDisplay } from './RemoteCursorOverlay';
import type { CursorViewportSize, StackCursorProjectionContext } from './remoteCursorProjection';
import {
  isStackCursorProjectionReady,
  projectSharedCursor,
  sampleSharedCursor,
} from './remoteCursorProjection';

export type RemoteCursorControllerState = Readonly<{
  cursors: readonly RemoteCursorDisplay[];
  colorRegistry: TaskColorRegistrySnapshot | null;
  viewportSize: CursorViewportSize;
  supported: boolean;
}>;

export type RemoteCursorControllerOptions = Readonly<{
  element: HTMLElement;
  participation: LocalParticipationPort;
  getContext: () => StackCursorProjectionContext;
  getViewReady: () => boolean;
  subscribeView: (listener: () => void) => () => void;
  onChange: (state: RemoteCursorControllerState) => void;
  events?: readonly string[];
  clock?: LocalClockPort;
}>;

const defaultEvents = [
  'CORNERSTONE_CAMERA_MODIFIED',
  'CORNERSTONE_IMAGE_RENDERED',
  'CORNERSTONE_STACK_NEW_IMAGE',
  'CORNERSTONE_PRE_STACK_NEW_IMAGE',
];

// 一个参与端口可有多个视口；只有最近收到指针采样的视口拥有本机位置。
const pointerOwners = new WeakMap<LocalParticipationPort, RemoteCursorController>();

function cursorKey(cursor: SharedCursorPosition | null): string {
  return cursor === null
    ? 'null'
    : JSON.stringify([
        cursor.selection_index,
        cursor.study_uid,
        cursor.series_uid,
        cursor.sop_uid,
        cursor.frame_number,
        cursor.coordinate_space,
        cursor.columns,
        cursor.rows,
        cursor.column,
        cursor.row,
      ]);
}

function frameKey(context: StackCursorProjectionContext): string {
  const frame = context.frame;
  return JSON.stringify([
    context.viewportType,
    isStackCursorProjectionReady(context),
    frame?.selection_index,
    frame?.study_uid,
    frame?.series_uid,
    frame?.sop_uid,
    frame?.frame_number,
    frame?.columns,
    frame?.rows,
  ]);
}

function eventImageId(event: Event): string | null {
  const imageId = (event as CustomEvent<{ imageId?: unknown }>).detail?.imageId;
  return typeof imageId === 'string' && imageId.length > 0 ? imageId : null;
}

/** 仅消费只读参与投影；节流、心跳、seq 和共享实例仍由原参与端口拥有。 */
export class RemoteCursorController {
  private disposed = false;
  private refreshing = false;
  private waitingForFrame = false;
  private stackCompleted = false;
  private pendingNativeImageId: string | null = null;
  private previousFrame: string | undefined;
  private pointer: { clientX: number; clientY: number } | null = null;
  private submitted: string | null = null;
  private readonly releases: Array<() => void> = [];
  private readonly remoteSamples = new Map<string, { seq: number; key: string }>();
  private readonly remoteFloors = new Map<string, number>();
  private observer: ResizeObserver | undefined;
  private readonly document: Document;
  private focused: boolean;
  private state: RemoteCursorControllerState = {
    cursors: [],
    colorRegistry: null,
    viewportSize: { width: 0, height: 0 },
    supported: false,
  };

  constructor(private readonly options: RemoteCursorControllerOptions) {
    this.document = options.element.ownerDocument;
    this.focused = this.document.hasFocus();
    try {
      this.listen(options.element, 'pointermove', this.onPointer);
      this.listen(options.element, 'pointerenter', this.onPointer);
      this.listen(options.element, 'pointerleave', this.onLeave);
      this.listen(options.element, 'pointercancel', this.onLeave);
      for (const event of new Set(options.events ?? defaultEvents)) {
        this.listen(options.element, event, this.onViewEvent);
      }
      const window = this.document.defaultView;
      if (window) {
        this.listen(window, 'blur', this.onBlur);
        this.listen(window, 'focus', this.onFocus);
        this.listen(window, 'resize', this.refresh);
      }
      this.listen(this.document, 'visibilitychange', this.onVisibility);
      this.releases.push(options.participation.subscribe(this.refresh));
      this.releases.push(options.subscribeView(this.refresh));
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(this.refresh);
        this.observer.observe(options.element);
      }
      this.refresh();
    } catch (error) {
      this.cleanup(false);
      throw error;
    }
  }

  private listen(target: EventTarget, event: string, listener: EventListener) {
    target.addEventListener(event, listener);
    this.releases.push(() => target.removeEventListener(event, listener));
  }

  private context(): StackCursorProjectionContext {
    try {
      return this.options.getContext();
    } catch {
      return {
        viewportType: 'unavailable',
        frame: null,
        transform: null,
        viewportSize: { width: 0, height: 0 },
      };
    }
  }

  private active(snapshot: LocalParticipationSnapshot): boolean {
    return (
      snapshot.phase === 'active' &&
      this.options.participation.identity.isCurrent() &&
      this.options.getViewReady()
    );
  }

  private onPointer = (event: Event) => {
    if (this.disposed) {
      return;
    }
    // 先处理尚未收到原生事件的帧变化，再把本事件作为该帧的新样本。
    this.refresh();
    const pointer = event as PointerEvent;
    if (
      !this.focused ||
      this.document.visibilityState === 'hidden' ||
      this.waitingForFrame ||
      !Number.isFinite(pointer.clientX) ||
      !Number.isFinite(pointer.clientY) ||
      !this.active(this.options.participation.getSnapshot()) ||
      !isStackCursorProjectionReady(this.context())
    ) {
      return;
    }
    this.pointer = { clientX: pointer.clientX, clientY: pointer.clientY };
    if (pointerOwners.get(this.options.participation) !== this) {
      this.submitted = null;
    }
    pointerOwners.set(this.options.participation, this);
    this.refresh();
  };

  private onLeave = () => {
    if (!this.disposed) {
      this.clearOwnedCursor();
    }
  };
  private onBlur = () => {
    this.focused = false;
    this.onLeave();
  };
  private onFocus = () => {
    if (!this.disposed) {
      this.focused = true;
    }
  };
  private onVisibility = () => {
    if (this.document.visibilityState === 'hidden') {
      this.onBlur();
    } else if (!this.disposed) {
      this.focused = this.document.hasFocus();
    }
  };

  private onViewEvent = (event: Event) => {
    if (this.disposed) {
      return;
    }
    if (event.type === 'CORNERSTONE_PRE_STACK_NEW_IMAGE') {
      this.waitingForFrame = true;
      this.stackCompleted = false;
      // 仅用于本窗加载事件配对，不作为原图定位或跨窗字段。
      this.pendingNativeImageId = eventImageId(event);
      this.invalidateRemoteSamples(this.options.participation.getSnapshot());
      this.clearOwnedCursor();
    } else if (
      event.type === 'CORNERSTONE_STACK_NEW_IMAGE' &&
      this.waitingForFrame &&
      (this.pendingNativeImageId === null || eventImageId(event) === this.pendingNativeImageId)
    ) {
      // CPU 的 STACK 先于元数据和变换更新；记录完成，统一等待真正渲染。
      this.stackCompleted = true;
    } else if (
      event.type === 'CORNERSTONE_IMAGE_RENDERED' &&
      this.waitingForFrame &&
      this.stackCompleted &&
      isStackCursorProjectionReady(this.context())
    ) {
      this.waitingForFrame = false;
      this.stackCompleted = false;
      this.pendingNativeImageId = null;
    }
    this.refresh();
  };

  private clearOwnedCursor() {
    this.pointer = null;
    this.submitted = null;
    if (pointerOwners.get(this.options.participation) === this) {
      pointerOwners.delete(this.options.participation);
      // null 也交协议清掉尚未发出的移动；不修改窗口级 view_ready。
      this.options.participation.sendCursor(null);
    }
  }

  private invalidateRemoteSamples(snapshot: LocalParticipationSnapshot) {
    for (const member of snapshot.members) {
      if (member.participant_id !== this.options.participation.identity.participant_id) {
        this.remoteFloors.set(
          member.participant_id,
          Math.max(this.remoteFloors.get(member.participant_id) ?? -1, member.cursor_seq)
        );
      }
    }
  }

  private registry(snapshot: LocalParticipationSnapshot): TaskColorRegistrySnapshot | null {
    const registry = snapshot.color_registry;
    if (
      !registry ||
      registry.task_id !== this.options.participation.identity.task_id ||
      registry.source_participant_id !== snapshot.source_participant_id ||
      !Number.isSafeInteger(registry.revision) ||
      registry.revision < 1
    ) {
      return null;
    }
    const uids = new Set<string>(),
      keys = new Set<string>(),
      colors = new Set<string>();
    for (const item of registry.assignments) {
      if (
        !item.uid ||
        !item.color_key ||
        !/^#[0-9A-F]{6}$/.test(item.color_value) ||
        uids.has(item.uid) ||
        keys.has(item.color_key) ||
        colors.has(item.color_value)
      ) {
        return null;
      }
      uids.add(item.uid);
      keys.add(item.color_key);
      colors.add(item.color_value);
    }
    return uids.has(this.options.participation.identity.user.uid) ? registry : null;
  }

  private sample(context: StackCursorProjectionContext) {
    if (!this.pointer || pointerOwners.get(this.options.participation) !== this) {
      return;
    }
    const rect = this.options.element.getBoundingClientRect();
    const cursor = sampleSharedCursor(
      {
        x: this.pointer.clientX - rect.left,
        y: this.pointer.clientY - rect.top,
      },
      context
    );
    if (!cursor) {
      this.clearOwnedCursor();
      return;
    }
    const key = cursorKey(cursor);
    if (key !== this.submitted) {
      // 先记录再发送，避免同步参与订阅重入后重复采样同一点。
      this.submitted = key;
      this.options.participation.sendCursor(cursor);
    }
  }

  refresh = () => {
    if (this.disposed || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const context = this.context();
      let snapshot = this.options.participation.getSnapshot();
      const key = frameKey(context);
      if (this.previousFrame !== undefined && key !== this.previousFrame) {
        // 原生目标会先于像素加载改变；上下文变化不能替代 PRE 对应的完成事件。
        this.invalidateRemoteSamples(snapshot);
        this.clearOwnedCursor();
      }
      this.previousFrame = key;
      const supported = isStackCursorProjectionReady(context);
      const active = this.active(snapshot);
      if (!active || !supported || this.waitingForFrame) {
        this.clearOwnedCursor();
      } else {
        this.sample(context);
      }
      if (this.disposed) {
        return;
      }
      // sendCursor 可同步触发频道故障与关闭；不能沿用发送前的 active 快照。
      snapshot = this.options.participation.getSnapshot();
      const displayActive = this.active(snapshot);
      if (!displayActive) {
        this.clearOwnedCursor();
      }
      const registry = this.registry(snapshot);
      const cursors: RemoteCursorDisplay[] = [];
      if (displayActive && supported && registry && !this.waitingForFrame) {
        for (const member of snapshot.members) {
          if (member.participant_id === this.options.participation.identity.participant_id) {
            continue;
          }
          const key = cursorKey(member.cursor);
          const previous = this.remoteSamples.get(member.participant_id);
          if (
            !Number.isSafeInteger(member.cursor_seq) ||
            member.cursor_seq < 0 ||
            (previous &&
              (member.cursor_seq < previous.seq ||
                (member.cursor_seq === previous.seq && key !== previous.key)))
          ) {
            continue;
          }
          this.remoteSamples.set(member.participant_id, { seq: member.cursor_seq, key });
          const assignment = registry.assignments.find(item => item.uid === member.user.uid);
          if (
            member.cursor_seq <= (this.remoteFloors.get(member.participant_id) ?? 0) ||
            !assignment ||
            assignment.color_key !== member.color_key
          ) {
            continue;
          }
          const point = projectSharedCursor(member.cursor, context);
          if (point) {
            cursors.push({ participant: member, point });
          }
        }
      }
      this.state = Object.freeze({
        cursors: Object.freeze(cursors),
        colorRegistry: registry,
        viewportSize: context.viewportSize,
        supported,
      });
      this.options.onChange(this.state);
    } finally {
      this.refreshing = false;
    }
  };

  private cleanup(emit: boolean) {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stackCompleted = false;
    this.pendingNativeImageId = null;
    this.clearOwnedCursor();
    for (const release of this.releases.splice(0)) {
      try {
        release();
      } catch {
        /* 继续释放其余本控制器资源。 */
      }
    }
    this.observer?.disconnect();
    this.remoteSamples.clear();
    this.remoteFloors.clear();
    if (emit) {
      this.state = Object.freeze({ ...this.state, cursors: [], colorRegistry: null });
      this.options.onChange(this.state);
    }
  }

  dispose = () => this.cleanup(true);
}
