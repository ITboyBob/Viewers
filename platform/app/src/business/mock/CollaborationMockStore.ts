import type {
  BusinessUserSummary,
  CollaborationMockApi,
  CollaborationRecipient,
  InvitationDecision,
  MockInvitation,
} from '@ohif/core';
import { collaborationFixtures } from './collaborationFixtures';

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const prefix = 'colla.phaseOne.collaborationMock.v1.';
const lifetime = 300000;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 同标签页的同步读-判定-写；没有网络、路由、团队、project 或 task 依赖。 */
export class CollaborationMockStore implements CollaborationMockApi {
  readonly recipients: readonly CollaborationRecipient[];
  private readonly key: string;
  private records: MockInvitation[] = [];
  private fault: string | null = null;

  constructor(
    private readonly user: BusinessUserSummary,
    private readonly storage: StoragePort | null,
    private readonly clock: () => number = Date.now
  ) {
    this.key = prefix + encodeURIComponent(user.uid);
    this.recipients = Object.freeze(
      collaborationFixtures.filter(item => item.uid !== user.uid && item.username !== user.username)
    );
    this.refresh();
  }

  clockNow(): number {
    return this.clock();
  }
  getError(): string | null {
    return this.fault;
  }

  private refresh(): void {
    if (this.fault) {
      return;
    }
    if (!this.storage) {
      this.fault = '协作模拟存储不可用，不能发送邀请。';
      return;
    }
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) {
        if (this.records.length) {
          throw new Error('已见到的邀请记录丢失');
        }
        return;
      }
      const value: unknown = JSON.parse(raw);
      if (
        !object(value) ||
        value.version !== 1 ||
        value.sender_uid !== this.user.uid ||
        !Array.isArray(value.invitations)
      ) {
        throw new Error('数据版本或发起者不匹配');
      }
      const ids = new Set<string>();
      for (const record of value.invitations) {
        if (!this.validRecord(record) || ids.has(record.mock_id)) {
          throw new Error('记录损坏');
        }
        ids.add(record.mock_id);
      }
      const incoming = value.invitations as MockInvitation[];
      // 本版本从不删除历史或改截止；同实例发现存储回退时不能恢复成可立即发送。
      for (const previous of this.records) {
        const next = incoming.find(item => item.mock_id === previous.mock_id);
        if (
          !next ||
          next.recipient_uid !== previous.recipient_uid ||
          next.created_at !== previous.created_at ||
          next.expires_at !== previous.expires_at ||
          (previous.decision !== 'pending' && next.decision !== previous.decision)
        ) {
          throw new Error('邀请记录被删除、改时或回退');
        }
      }
      this.records = incoming.map(item => ({ ...item }));
    } catch {
      this.fault = '协作模拟存储读取失败或数据损坏，已阻止发送；不会重置原五分钟窗口。';
    }
  }

  private validRecord(value: unknown): value is MockInvitation {
    if (!object(value) || Object.keys(value).length !== 8) {
      return false;
    }
    const recipient = this.recipients.find(item => item.uid === value.recipient_uid);
    return (
      value.kind === 'collaboration_mock' &&
      typeof value.mock_id === 'string' &&
      value.mock_id.length > 0 &&
      value.sender_uid === this.user.uid &&
      !!recipient &&
      value.recipient_username === recipient.username &&
      typeof value.created_at === 'number' &&
      Number.isSafeInteger(value.created_at) &&
      value.created_at >= 0 &&
      typeof value.expires_at === 'number' &&
      Number.isSafeInteger(value.expires_at) &&
      value.expires_at - value.created_at === lifetime &&
      typeof value.decision === 'string' &&
      ['pending', 'accepted', 'rejected'].includes(value.decision)
    );
  }

  private requireHealthy(): void {
    this.refresh();
    if (this.fault) {
      throw new Error(this.fault);
    }
  }

  private persist(records: MockInvitation[]): void {
    // 先保留内存禁用状态；写失败不能报告成功或提前恢复邀请。
    this.records = records;
    try {
      this.storage!.setItem(
        this.key,
        JSON.stringify({ version: 1, sender_uid: this.user.uid, invitations: records })
      );
    } catch {
      this.fault = '协作模拟存储写入失败，已阻止发送；当前页面刷新后的状态保持无法保证。';
      throw new Error(this.fault);
    }
  }

  list(): MockInvitation[] {
    this.requireHealthy();
    return this.records.map(item => ({ ...item }));
  }

  isInvited(username: string): boolean {
    this.refresh();
    return (
      !!this.fault ||
      this.records.some(
        item => item.recipient_username === username && this.clockNow() < item.expires_at
      )
    );
  }

  invite(username: string): MockInvitation {
    this.requireHealthy();
    const recipient = this.recipients.find(item => item.username === username.trim());
    if (!recipient) {
      throw new Error('请选择非本人的已注册合成用户；不查询真实用户。');
    }
    if (this.isInvited(recipient.username)) {
      throw new Error('五分钟内已邀请该合成用户。');
    }
    const now = this.clockNow();
    const record: MockInvitation = {
      kind: 'collaboration_mock',
      mock_id: 'mock:' + JSON.stringify([this.user.uid, recipient.uid, now]),
      sender_uid: this.user.uid,
      recipient_uid: recipient.uid,
      recipient_username: recipient.username,
      created_at: now,
      expires_at: now + lifetime,
      decision: 'pending',
    };
    this.persist([...this.records, record]);
    return { ...record };
  }

  decide(id: string, decision: Exclude<InvitationDecision, 'pending'>): MockInvitation {
    this.requireHealthy();
    const record = this.records.find(item => item.mock_id === id);
    if (!record) {
      throw new Error('协作模拟记录不存在。');
    }
    if (this.clockNow() >= record.expires_at) {
      throw new Error('邀请已超过有效期，不能处理。');
    }
    if (record.decision !== 'pending' && record.decision !== decision) {
      throw new Error('邀请已按其他决定处理。');
    }
    if (record.decision === decision) {
      return { ...record };
    }
    const updated = { ...record, decision };
    this.persist(this.records.map(item => (item.mock_id === id ? updated : item)));
    return { ...updated };
  }
}
