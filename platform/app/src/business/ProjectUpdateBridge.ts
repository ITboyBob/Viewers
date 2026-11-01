import type {
  BusinessApiFailure,
  LocalProject,
  LocalProjects,
  TaskApi,
  ProjectEventService,
} from '@ohif/core';

/** 只消费当前servicesManager的PubSub对象，不监听DOM或上传广播内容。 */
type Options = {
  project: LocalProject;
  projects: LocalProjects;
  tasks: TaskApi;
  measurementService: ProjectEventService;
  segmentationService: ProjectEventService;
  isActive(): boolean;
  notify(message: string): void;
};
type Kind = 'measurement' | 'segmentation';
const nestedFields = [
  'measurement',
  'measurements',
  'segmentation',
  'metadata',
  'representationData',
  'Labelmap',
  'representation',
  'data',
  'segDisplaySet',
  'pmapDisplaySet',
];
const referenceFields = {
  study: ['StudyInstanceUID', 'referenceStudyUID', 'study_uid'],
  series: ['SeriesInstanceUID', 'referenceSeriesUID', 'series_uid'],
  sop: ['SOPInstanceUID', 'sop_uid'],
  image: ['referencedImageId', 'referencedImageIds', 'image_id'],
  scope: ['scope_id', 'batch_id'],
};
export class ProjectUpdateBridge {
  private stopped = false;
  private started = false;
  private queue: Array<() => boolean> = [];
  private flight: AbortController | null = null;
  private subscriptions: Array<{ unsubscribe(): void }> = [];
  private known = {
    measurement: new Map<string, boolean>(),
    segmentation: new Map<string, boolean>(),
  };
  private references: Record<keyof typeof referenceFields, Set<string>>;
  constructor(private readonly options: Options) {
    const p = options.project;
    this.references = {
      study: new Set(p.study_uids),
      series: new Set(p.successes.map(item => item.series_uid)),
      sop: new Set(p.successes.map(item => item.sop_uid)),
      image: new Set(p.successes.map(item => item.image_id)),
      scope: new Set([p.batch_id]),
    };
  }
  private eligible = () =>
    !this.stopped &&
    this.options.isActive() &&
    this.options.projects.isCurrent(this.options.project) &&
    this.options.project.phase === 'registered' &&
    Boolean(this.options.project.task_id);

  start = () => {
    if (this.started || !this.eligible()) {
      return this.stop;
    }
    this.started = true;
    try {
      const services: Array<[Kind, ProjectEventService]> = [
        ['measurement', this.options.measurementService],
        ['segmentation', this.options.segmentationService],
      ];
      for (const [kind, service] of services) {
        const resources =
          kind === 'measurement' ? service.getMeasurements?.() : service.getSegmentations?.();
        resources?.forEach(resource => this.belongs(kind, resource));
        for (const event of new Set(Object.values(service.EVENTS))) {
          this.subscriptions.push(
            service.subscribe(event, payload => {
              if (!this.eligible() || !this.belongs(kind, payload)) {
                return;
              }
              this.queue.push(() => this.belongs(kind, payload));
              void this.drain();
            })
          );
        }
      }
    } catch (error) {
      this.stop();
      throw error;
    }
    return this.stop;
  };
  stop = () => {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.queue = [];
    try {
      for (const subscription of this.subscriptions.splice(0)) {
        try {
          subscription.unsubscribe();
        } catch {
          /* 仍清理其余订阅 */
        }
      }
    } finally {
      this.flight?.abort();
    }
  };
  private async drain() {
    if (this.flight) {
      return;
    }
    while (this.queue.length && this.eligible()) {
      if (!this.queue.shift()()) {
        continue;
      }
      const controller = new AbortController();
      this.flight = controller;
      try {
        const value = await this.options.tasks.touch(this.options.project, controller.signal);
        if (this.eligible() && !controller.signal.aborted) {
          this.options.projects.updateTimestamp(this.options.project, value);
        }
      } catch (error) {
        if (this.eligible() && !controller.signal.aborted) {
          if ([401, 403, 404].includes((error as BusinessApiFailure).status)) {
            this.stop();
            this.options.projects.invalidate(this.options.project);
            this.options.notify('项目资格已失效，请重新导入');
          } else {
            this.options.notify('项目时间未更新，请在下次操作后重试');
          }
        }
      } finally {
        if (this.flight === controller) {
          this.flight = null;
        }
      }
    }
  }
  /** 对可识别旧资源拒绝；无资源的清空／加载广播属于当前有效生命周期。 */
  private belongs(kind: Kind, payload: unknown): boolean {
    const visited = new WeakSet<object>();
    const service =
      kind === 'measurement' ? this.options.measurementService : this.options.segmentationService;
    const inspect = (value: unknown): boolean | undefined => {
      if (typeof value === 'string') {
        const resource =
          kind === 'measurement'
            ? service.getMeasurement?.(value)
            : service.getSegmentation?.(value);
        return resource ? inspect(resource) : this.known[kind].get(value);
      }
      if (!value || typeof value !== 'object' || visited.has(value)) {
        return undefined;
      }
      visited.add(value);
      if (Array.isArray(value)) {
        const verdicts = value.map(inspect).filter(item => item !== undefined);
        return verdicts.length ? verdicts.some(Boolean) : undefined;
      }
      const record = value as Record<string, unknown>;
      const id = kind === 'measurement' ? record.uid : record.segmentationId;
      const finish = (verdict: boolean | undefined) => {
        if (typeof id === 'string' && verdict !== undefined) {
          this.known[kind].set(id, verdict);
        }
        return verdict;
      };
      let result: boolean | undefined;
      for (const group of Object.keys(referenceFields) as Array<keyof typeof referenceFields>) {
        for (const field of referenceFields[group]) {
          const reference = record[field];
          const values = Array.isArray(reference) ? reference : [reference];
          for (const item of values) {
            if (typeof item !== 'string' || !item) {
              continue;
            }
            if (!this.references[group].has(item)) {
              return finish(false);
            }
            result = true;
          }
        }
      }
      for (const field of nestedFields) {
        const verdict = inspect(record[field]);
        if (verdict === false) {
          return finish(false);
        }
        if (verdict === true) {
          result = true;
        }
      }
      if (result === undefined && typeof id === 'string') {
        const resource =
          kind === 'measurement' ? service.getMeasurement?.(id) : service.getSegmentation?.(id);
        result = inspect(resource) ?? this.known[kind].get(id);
      }
      return finish(result);
    };
    return inspect(payload) !== false;
  }
}
