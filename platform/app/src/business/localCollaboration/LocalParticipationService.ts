import type {
  LocalParticipantIdentity,
  LocalParticipantSnapshot,
  LocalParticipationOptions,
  LocalParticipationPort,
  LocalParticipationSnapshot,
  LocalReadyState,
  LocalSharingLeaveReason,
  LocalSharingMessage,
  LocalSharingUnavailableReason,
  LocalSharingUser,
  SharedCursorPosition,
} from '@ohif/core';
import { TaskColorRegistry, validateColorRegistry } from './TaskColorRegistry';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;
const keys = (value: Record<string, unknown>, names: string) =>
  Object.keys(value).sort().join() === names.split(',').sort().join();
const user = (value: unknown): value is LocalSharingUser =>
  record(value) && keys(value, 'uid,username') && text(value.uid) && text(value.username);
const sameUser = (a: LocalSharingUser, b: LocalSharingUser) =>
  a.uid === b.uid && a.username === b.username;
const reasons = ['exit', 'identity_invalid', 'source_invalid'];
const unavailable = [
  'not_ready',
  'source_closed',
  'identity_invalid',
  'cache_invalid',
  'color_unavailable',
];

function validCursor(value: unknown): value is SharedCursorPosition | null {
  if (value === null) {
    return true;
  }
  return (
    record(value) &&
    keys(
      value,
      'selection_index,study_uid,series_uid,sop_uid,frame_number,coordinate_space,column,row,columns,rows'
    ) &&
    integer(value.selection_index) &&
    [value.study_uid, value.series_uid, value.sop_uid].every(text) &&
    integer(value.frame_number, 1) &&
    value.coordinate_space === 'image-pixel-center' &&
    integer(value.columns, 1) &&
    integer(value.rows, 1) &&
    typeof value.column === 'number' &&
    Number.isFinite(value.column) &&
    typeof value.row === 'number' &&
    Number.isFinite(value.row) &&
    value.column >= 0 &&
    value.column <= value.columns - 1 &&
    value.row >= 0 &&
    value.row <= value.rows - 1
  );
}
function validMember(value: unknown): value is LocalParticipantSnapshot {
  return (
    record(value) &&
    keys(value, 'participant_id,user,role,color_key,cursor_seq,cursor') &&
    text(value.participant_id) &&
    user(value.user) &&
    (value.role === 'source' || value.role === 'viewer') &&
    text(value.color_key) &&
    integer(value.cursor_seq) &&
    validCursor(value.cursor) &&
    (value.cursor === null || (value.cursor_seq as number) > 0)
  );
}
function validMessage(value: unknown): value is LocalSharingMessage {
  if (
    !record(value) ||
    value.protocol_version !== 1 ||
    !text(value.task_id) ||
    !text(value.participant_id) ||
    !integer(value.seq, 1) ||
    !(value.source_participant_id === null || text(value.source_participant_id))
  ) {
    return false;
  }
  const base = 'protocol_version,task_id,source_participant_id,participant_id,seq,kind';
  switch (value.kind) {
    case 'join':
      return (
        keys(value, base + ',user,join_phase') &&
        user(value.user) &&
        (value.join_phase === 'loading' || value.join_phase === 'active') &&
        (value.source_participant_id !== null || value.join_phase === 'loading')
      );
    case 'state':
      if (
        !text(value.source_participant_id) ||
        !text(value.target_participant_id) ||
        !integer(value.reply_to_seq, 1)
      ) {
        return false;
      }
      return value.result === 'ready'
        ? keys(
            value,
            base + ',target_participant_id,reply_to_seq,result,batch_id,members,color_registry'
          ) &&
            text(value.batch_id) &&
            Array.isArray(value.members) &&
            value.members.every(validMember)
        : value.result === 'unavailable' &&
            keys(value, base + ',target_participant_id,reply_to_seq,result,reason') &&
            unavailable.includes(value.reason as string);
    case 'heartbeat':
      return value.source_participant_id !== null && keys(value, base);
    case 'cursor':
      return (
        value.source_participant_id !== null &&
        keys(value, base + ',cursor') &&
        validCursor(value.cursor)
      );
    case 'leave':
      return (
        value.source_participant_id !== null &&
        keys(value, base + ',reason') &&
        reasons.includes(value.reason as string)
      );
    default:
      return false;
  }
}
const freezeMember = (member: LocalParticipantSnapshot): LocalParticipantSnapshot =>
  Object.freeze({
    ...member,
    user: Object.freeze({ ...member.user }),
    cursor: member.cursor && Object.freeze({ ...member.cursor }),
  });
type JoinMessage = Extract<LocalSharingMessage, { kind: 'join' }>;
type Pending = {
  seq: number;
  phase: 'loading' | 'active';
  timer: unknown;
  resolve: (state: LocalReadyState) => void;
  reject: (error: Error) => void;
};

/** 单次参与生命周期；异步完成点重新核对原 identity 与请求序号。 */
export class LocalParticipationService implements LocalParticipationPort {
  readonly identity: LocalParticipantIdentity;
  private snapshot: LocalParticipationSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly members = new Map<string, LocalParticipantSnapshot>();
  private readonly lastSeq = new Map<string, number>();
  private readonly lastSeen = new Map<string, number>();
  private readonly closedParticipants = new Set<string>();
  private readonly candidates = new Map<string, { user: LocalSharingUser; loadingSeq: number }>();
  private readonly checking = new Map<string, { user: LocalSharingUser; seq: number }>();
  private readonly releases: (() => void)[] = [];
  private readonly registry: TaskColorRegistry | null;
  private pending: Pending | null = null;
  private heartbeatTimer: unknown;
  private sweepTimer: unknown;
  private cursorTimer: unknown;
  private latestCursor: SharedCursorPosition | null = null;
  private pendingHide = false;
  private lastCursorSent = -Infinity;
  private viewReady = false;

  constructor(private readonly options: LocalParticipationOptions) {
    const { identity, source, verifier, channel } = options;
    if (
      !identity.isCurrent() ||
      (identity.role === 'source' &&
        (!source || source.identity !== identity || !source.isCurrent() || !verifier)) ||
      (identity.role === 'viewer' && source)
    ) {
      throw new Error('参与上下文不匹配或缺少源复核端口');
    }
    this.identity = identity;
    this.registry = source
      ? new TaskColorRegistry(identity.task_id, identity.participant_id, identity.user.uid)
      : null;
    if (source) {
      this.members.set(
        identity.participant_id,
        freezeMember({
          participant_id: identity.participant_id,
          user: identity.user,
          role: 'source',
          color_key: this.registry!.getSnapshot().assignments[0].color_key,
          cursor_seq: 0,
          cursor: null,
        })
      );
      this.viewReady = source.getSnapshot().view_ready;
    }
    this.snapshot = Object.freeze({
      phase: source ? 'active' : 'idle',
      source_participant_id: source ? identity.participant_id : null,
      batch_id: source?.batch_id ?? null,
      members: Object.freeze([...this.members.values()]),
      color_registry: this.registry?.getSnapshot() ?? null,
      error: null,
    });
    this.releases.push(channel.subscribe(value => this.receive(value)));
    this.releases.push(identity.subscribe(() => this.finish('identity_invalid')));
    if (source) {
      this.releases.push(
        source.subscribe(() => {
          if (source.getSnapshot().publication_phase === 'cancelled') {
            this.close('source_invalid');
          } else {
            this.viewReady = source.getSnapshot().view_ready;
            if (!this.viewReady) {
              this.hideLocalCursor();
            }
          }
        })
      );
      this.startHeartbeat();
    }
    this.sweep();
  }
  getSnapshot = (): LocalParticipationSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<LocalParticipationSnapshot> = {}) {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      members: Object.freeze([...this.members.values()]),
      ...update,
    });
    this.listeners.forEach(listener => listener());
  }
  private current() {
    return (
      this.snapshot.phase !== 'closed' &&
      this.identity.isCurrent() &&
      (!this.options.source || this.options.source.isCurrent())
    );
  }
  private open() {
    return this.snapshot.phase !== 'closed';
  }
  private post(payload: Record<string, unknown>, terminal = false): number {
    if (!this.current() && !terminal) {
      return 0;
    }
    try {
      const seq = this.identity.nextSeq();
      this.options.channel.postMessage({
        protocol_version: 1,
        task_id: this.identity.task_id,
        source_participant_id: this.snapshot.source_participant_id,
        participant_id: this.identity.participant_id,
        seq,
        ...payload,
      } as LocalSharingMessage);
      return seq;
    } catch (error) {
      void error;
      this.finish('channel_unavailable');
      return 0;
    }
  }
  join(phase: 'loading' | 'active'): Promise<LocalReadyState> {
    if (
      !this.current() ||
      this.identity.role !== 'viewer' ||
      (phase === 'active' && !this.snapshot.source_participant_id) ||
      (phase === 'loading' && this.snapshot.phase === 'active')
    ) {
      return Promise.reject(new Error('本次参与不能执行该握手'));
    }
    this.rejectPending('join_replaced');
    this.publish({ error: null });
    return new Promise((resolve, reject) => {
      // 先登记 pending 再发送，兼容同步受控频道与异步原生频道。
      const seq = this.identity.nextSeq();
      const timer = this.options.clock.setTimeout(() => {
        if (this.pending?.seq === seq) {
          this.rejectPending('join_timeout');
          this.publish({ error: 'join_timeout' });
        }
      }, 20000);
      this.pending = { seq, phase, timer, resolve, reject };
      try {
        this.options.channel.postMessage({
          protocol_version: 1,
          task_id: this.identity.task_id,
          source_participant_id: this.snapshot.source_participant_id,
          participant_id: this.identity.participant_id,
          seq,
          kind: 'join',
          user: { ...this.identity.user },
          join_phase: phase,
        });
      } catch (error) {
        void error;
        this.finish('channel_unavailable');
      }
    });
  }
  private rejectPending(reason: string) {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      this.options.clock.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }
  private receive(value: unknown) {
    if (
      !this.current() ||
      !validMessage(value) ||
      value.task_id !== this.identity.task_id ||
      value.participant_id === this.identity.participant_id ||
      this.closedParticipants.has(value.participant_id) ||
      this.expire(value.participant_id)
    ) {
      return;
    }
    if (value.kind === 'join' && this.options.source) {
      void this.sourceJoin(value);
      return;
    }
    if (value.kind === 'state' && this.identity.role === 'viewer') {
      this.acceptState(value);
      return;
    }
    if (value.source_participant_id !== this.snapshot.source_participant_id) {
      return;
    }
    const known = this.members.get(value.participant_id);
    const candidate =
      this.candidates.has(value.participant_id) || this.checking.has(value.participant_id);
    if (
      (!known && !(candidate && value.kind === 'leave')) ||
      value.seq <= (this.lastSeq.get(value.participant_id) ?? 0)
    ) {
      return;
    }
    if (value.kind === 'cursor' && !this.cursorInSource(value.cursor)) {
      return;
    }
    this.lastSeq.set(value.participant_id, value.seq);
    if (value.kind === 'leave') {
      this.remove(value.participant_id);
      if (value.participant_id === this.snapshot.source_participant_id) {
        this.finish('source_closed');
      } else {
        this.publish();
      }
    } else if (value.kind === 'heartbeat' || value.kind === 'cursor') {
      this.lastSeen.set(value.participant_id, this.options.clock.now());
      if (value.kind === 'cursor' && value.seq > known!.cursor_seq) {
        this.members.set(
          value.participant_id,
          freezeMember({ ...known!, cursor_seq: value.seq, cursor: value.cursor })
        );
        this.publish();
      }
    }
  }
  private sourceReady(): LocalSharingUnavailableReason | null {
    const source = this.options.source!;
    if (!this.current()) {
      return 'source_closed';
    }
    const { publication_phase, manifest } = source.getSnapshot();
    if (publication_phase !== 'ready') {
      return 'not_ready';
    }
    if (
      !manifest ||
      manifest.cache_version !== 1 ||
      manifest.cache_state !== 'ready' ||
      manifest.task_id !== this.identity.task_id ||
      manifest.batch_id !== source.batch_id ||
      manifest.source_participant_id !== this.identity.participant_id ||
      manifest.importer_uid !== this.identity.user.uid ||
      !manifest.files.length
    ) {
      return 'cache_invalid';
    }
    return null;
  }
  private async sourceJoin(message: JoinMessage) {
    const id = message.participant_id;
    if (
      message.source_participant_id !== null &&
      message.source_participant_id !== this.identity.participant_id
    ) {
      return;
    }
    const candidate = this.candidates.get(id);
    const established = this.members.get(id);
    const boundUser = established?.user ?? candidate?.user ?? this.checking.get(id)?.user;
    if (
      (boundUser && !sameUser(boundUser, message.user)) ||
      (message.join_phase === 'active' && (!candidate || message.seq <= candidate.loadingSeq)) ||
      message.seq <= (this.lastSeq.get(id) ?? 0)
    ) {
      return;
    }
    this.lastSeq.set(id, message.seq);
    this.checking.set(id, { user: { ...message.user }, seq: message.seq });
    let failure = this.sourceReady();
    if (!failure) {
      try {
        if (!(await this.options.verifier!.verify())) {
          failure = this.identity.isCurrent() ? 'not_ready' : 'identity_invalid';
        }
      } catch (error) {
        void error;
        failure = this.identity.isCurrent() ? 'not_ready' : 'identity_invalid';
      }
    }
    if (
      !this.current() ||
      this.closedParticipants.has(id) ||
      this.checking.get(id)?.seq !== message.seq
    ) {
      return;
    }
    this.checking.delete(id);
    failure = failure ?? this.sourceReady();
    if (!failure && message.join_phase === 'active') {
      const assignment = this.registry!.assign(message.user.uid);
      if (!assignment) {
        failure = 'color_unavailable';
      } else {
        this.members.set(
          id,
          this.members.get(id) ??
            freezeMember({
              participant_id: id,
              user: message.user,
              role: 'viewer',
              color_key: assignment.color_key,
              cursor_seq: 0,
              cursor: null,
            })
        );
        this.lastSeen.set(id, this.options.clock.now());
        this.publish({ color_registry: this.registry!.getSnapshot() });
      }
    }
    if (failure) {
      this.post({
        kind: 'state',
        target_participant_id: id,
        reply_to_seq: message.seq,
        result: 'unavailable',
        reason: failure,
      });
      return;
    }
    if (message.join_phase === 'loading') {
      this.candidates.set(id, {
        user: Object.freeze({ ...message.user }),
        loadingSeq: message.seq,
      });
    }
    this.post({
      kind: 'state',
      target_participant_id: id,
      reply_to_seq: message.seq,
      result: 'ready',
      batch_id: this.options.source!.batch_id,
      members: [...this.members.values()],
      color_registry: this.registry!.getSnapshot(),
    });
  }
  private acceptState(message: Extract<LocalSharingMessage, { kind: 'state' }>) {
    const pending = this.pending;
    if (
      !pending ||
      message.target_participant_id !== this.identity.participant_id ||
      message.reply_to_seq !== pending.seq ||
      message.participant_id !== message.source_participant_id ||
      (this.snapshot.source_participant_id &&
        message.source_participant_id !== this.snapshot.source_participant_id) ||
      message.seq <= (this.lastSeq.get(message.participant_id) ?? 0)
    ) {
      return;
    }
    if (message.result === 'unavailable') {
      this.rejectPending(message.reason);
      this.publish({ error: message.reason });
      if (['source_closed', 'identity_invalid', 'color_unavailable'].includes(message.reason)) {
        this.close('source_invalid');
      }
      return;
    }
    const sourceId = message.source_participant_id;
    const unique = new Set(message.members.map(member => member.participant_id));
    const sourceMember = message.members.find(member => member.participant_id === sourceId);
    const ownMember = message.members.find(
      member => member.participant_id === this.identity.participant_id
    );
    const registry = validateColorRegistry(
      message.color_registry,
      this.identity.task_id,
      sourceId,
      this.snapshot.color_registry,
      message.members
    );
    const valid =
      registry &&
      unique.size === message.members.length &&
      sourceMember?.role === 'source' &&
      registry.assignments[0].uid === sourceMember.user.uid &&
      message.members.filter(member => member.role === 'source').length === 1 &&
      (!this.snapshot.batch_id || this.snapshot.batch_id === message.batch_id) &&
      message.members.every(
        member =>
          !this.closedParticipants.has(member.participant_id) &&
          (!this.members.has(member.participant_id) ||
            sameUser(this.members.get(member.participant_id)!.user, member.user))
      ) &&
      (!ownMember ||
        (ownMember.role === 'viewer' && sameUser(ownMember.user, this.identity.user))) &&
      (pending.phase !== 'active' || !!ownMember);
    if (!valid) {
      this.rejectPending('invalid_state');
      if (this.snapshot.phase === 'active') {
        this.members.forEach((member, id) =>
          this.members.set(id, freezeMember({ ...member, cursor: null }))
        );
        this.publish({ error: 'invalid_state' });
      } else {
        this.publish({ error: 'invalid_state' });
        this.close('source_invalid');
      }
      return;
    }
    this.lastSeq.set(sourceId, message.seq);
    const incoming = new Set(message.members.map(member => member.participant_id));
    this.members.forEach((_member, id) => {
      if (!incoming.has(id)) {
        this.remove(id);
      }
    });
    for (const member of message.members) {
      const old = this.members.get(member.participant_id);
      this.members.set(
        member.participant_id,
        freezeMember(
          old && old.cursor_seq >= member.cursor_seq
            ? { ...member, cursor_seq: old.cursor_seq, cursor: old.cursor }
            : member
        )
      );
      // 快照不修改其他发送者 last_seq，也不刷新已有成员的心跳。
      if (!this.lastSeen.has(member.participant_id) || member.participant_id === sourceId) {
        this.lastSeen.set(member.participant_id, this.options.clock.now());
      }
    }
    this.options.clock.clearTimeout(pending.timer);
    this.pending = null;
    this.publish({
      phase: pending.phase === 'active' ? 'active' : 'loading',
      source_participant_id: sourceId,
      batch_id: message.batch_id,
      color_registry: registry,
      error: null,
    });
    if (pending.phase === 'active') {
      this.startHeartbeat();
    }
    pending.resolve(
      Object.freeze({ ...message, members: this.snapshot.members, color_registry: registry })
    );
  }
  private startHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      return;
    }
    this.post({ kind: 'heartbeat' });
    if (this.snapshot.phase === 'closed') {
      return;
    }
    const next = () => {
      if (this.current() && this.snapshot.phase === 'active') {
        if (this.pendingHide) {
          this.transmitCursor(null);
        }
        this.post({ kind: 'heartbeat' });
      }
      if (this.snapshot.phase !== 'closed') {
        this.heartbeatTimer = this.options.clock.setTimeout(next, 2000);
      }
    };
    this.heartbeatTimer = this.options.clock.setTimeout(next, 2000);
  }
  private sweep = () => {
    if (!this.open()) {
      return;
    }
    // isCurrent 的暂时 false 也可能来自入口校验；永久关闭由 identity 订阅通知。
    if (this.current()) {
      for (const id of this.lastSeen.keys()) {
        this.expire(id);
        if (!this.open()) {
          return;
        }
      }
    }
    if (this.open()) {
      this.sweepTimer = this.options.clock.setTimeout(this.sweep, 1000);
    }
  };
  private expire(id: string): boolean {
    const seen = this.lastSeen.get(id);
    if (
      id === this.identity.participant_id ||
      seen === undefined ||
      this.options.clock.now() - seen <= 15000
    ) {
      return false;
    }
    this.remove(id);
    if (id === this.snapshot.source_participant_id) {
      this.finish('source_closed');
    } else {
      this.publish();
    }
    return true;
  }
  private remove(id: string) {
    this.members.delete(id);
    this.lastSeen.delete(id);
    this.candidates.delete(id);
    this.checking.delete(id);
    this.closedParticipants.add(id);
  }
  private cursorInSource(cursor: SharedCursorPosition | null) {
    const manifest = this.options.source?.getSnapshot().manifest;
    return (
      cursor === null ||
      !manifest ||
      manifest.files.some(
        item =>
          item.selection_index === cursor.selection_index &&
          item.study_uid === cursor.study_uid &&
          item.series_uid === cursor.series_uid &&
          item.sop_uid === cursor.sop_uid
      )
    );
  }
  setViewReady(ready: boolean) {
    if (!this.current()) {
      return;
    }
    this.viewReady = ready;
    this.options.source?.setViewReady(ready);
    if (!ready) {
      this.hideLocalCursor();
    }
  }
  private hideLocalCursor() {
    this.latestCursor = null;
    this.options.clock.clearTimeout(this.cursorTimer);
    this.cursorTimer = undefined;
    if (this.members.get(this.identity.participant_id)?.cursor) {
      this.pendingHide = true;
      this.transmitCursor(null);
      const own = this.members.get(this.identity.participant_id);
      if (own?.cursor) {
        this.members.set(this.identity.participant_id, freezeMember({ ...own, cursor: null }));
        this.publish();
      }
    }
  }
  sendCursor(cursor: SharedCursorPosition | null) {
    if (cursor === null && this.snapshot.phase === 'active' && !this.current()) {
      // 身份复核暂停发送时仍须撤销旧采样，恢复后由心跳路径补发隐藏。
      this.hideLocalCursor();
      return;
    }
    if (
      !this.current() ||
      this.snapshot.phase !== 'active' ||
      !validCursor(cursor) ||
      !this.cursorInSource(cursor) ||
      (cursor !== null && !this.viewReady)
    ) {
      return;
    }
    this.latestCursor = cursor;
    if (cursor === null) {
      this.options.clock.clearTimeout(this.cursorTimer);
      this.cursorTimer = undefined;
      this.transmitCursor(null);
    } else if (this.cursorTimer === undefined) {
      const remaining = 50 - (this.options.clock.now() - this.lastCursorSent);
      if (remaining <= 0) {
        this.transmitCursor(cursor);
      } else {
        this.cursorTimer = this.options.clock.setTimeout(() => {
          this.cursorTimer = undefined;
          if (this.current() && this.viewReady && this.latestCursor) {
            this.transmitCursor(this.latestCursor);
          }
        }, remaining);
      }
    }
  }
  private transmitCursor(cursor: SharedCursorPosition | null) {
    const seq = this.post({ kind: 'cursor', cursor });
    const own = this.members.get(this.identity.participant_id);
    if (seq && own) {
      this.pendingHide = false;
      this.lastCursorSent = this.options.clock.now();
      this.members.set(
        this.identity.participant_id,
        freezeMember({ ...own, cursor_seq: seq, cursor })
      );
      this.publish();
    }
  }
  close(reason: LocalSharingLeaveReason = 'exit') {
    if (this.snapshot.phase === 'closed') {
      return;
    }
    // 工厂在 identity 的最终关闭之前调用此路径；仅最后 leave 可使用已失效身份。
    if (this.snapshot.source_participant_id) {
      this.post({ kind: 'leave', reason }, true);
    }
    this.finish(this.snapshot.error ?? reason);
  }
  private finish(error: string) {
    if (this.snapshot.phase === 'closed') {
      return;
    }
    this.rejectPending(error);
    this.options.clock.clearTimeout(this.heartbeatTimer);
    this.options.clock.clearTimeout(this.sweepTimer);
    this.options.clock.clearTimeout(this.cursorTimer);
    this.releases.splice(0).forEach(release => release());
    this.options.channel.close();
    this.members.clear();
    this.lastSeen.clear();
    this.candidates.clear();
    this.checking.clear();
    this.latestCursor = null;
    this.pendingHide = false;
    this.viewReady = false;
    this.publish({ phase: 'closed', error });
    this.identity.close(error === 'identity_invalid' ? 'identity_invalid' : 'source_invalid');
    this.listeners.clear();
  }
}
