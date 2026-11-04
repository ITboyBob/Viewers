import React, { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { DicomMetadataStore } from '@ohif/core';
import type {
  BusinessServices,
  BatchFailure,
  ImportSelection,
  LocalImportScope,
  LocalProject,
  ProjectLifecycleHandle,
  SharedFilePublicationPort,
} from '@ohif/core';

/** 导入页与看板共用的批次生命周期；登记成功后才向工作台转交资源。 */
export default function useLocalTaskImport(
  business: BusinessServices | undefined,
  microscopyLoaded: boolean,
  uiNotificationService?: {
    show(options: { title: string; message: string; type: 'warning'; duration: number }): unknown;
  }
) {
  const projects = business?.localProjects,
    tasks = business?.tasks,
    runtime = business?.projectRuntime;
  const publisher = business?.localCollaboration?.publisher;
  const navigate = useNavigate();
  const location = useLocation();
  const taskReturnTo = location.pathname === '/team/recent' ? '/team/recent' : '/team/tasks';
  const mounted = useRef(true),
    locked = useRef(false),
    transferred = useRef(false);
  const projectRef = useRef<LocalProject | null>(null);
  const publicationRef = useRef<ReturnType<SharedFilePublicationPort['prepare']> | null>(null);
  const preparedRef = useRef<{ project: LocalProject; scope: LocalImportScope } | null>(null);
  const ownsAttempt = useRef(false);
  const visitController = useRef<AbortController | null>(null);
  const [status, setStatus] = React.useState<'idle' | 'parsing' | 'registering'>('idle');
  const [error, setError] = React.useState('');
  const [failures, setFailures] = React.useState<readonly BatchFailure[]>([]);
  const [retryProject, setRetryProject] = React.useState<LocalProject | null>(null);
  const busy = status !== 'idle';

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = projects?.subscribe(() => {
      if (projectRef.current?.phase === 'invalid' && !transferred.current) {
        visitController.current?.abort();
        tasks?.cancel(projectRef.current);
        publicationRef.current?.cancel();
        preparedRef.current?.scope.release();
        preparedRef.current = null;
        if (projects.getCurrent() === projectRef.current) {
          projects.dispose();
        }
        if (mounted.current) {
          setRetryProject(null);
          setError('当前批次身份已失效，请重新选择。');
        }
      }
    });
    return () => {
      mounted.current = false;
      visitController.current?.abort();
      unsubscribe?.();
      if (!transferred.current && ownsAttempt.current) {
        if (projectRef.current) {
          visitController.current?.abort();
          tasks?.cancel(projectRef.current);
        }
        publicationRef.current?.cancel();
        try {
          preparedRef.current?.scope.release();
        } finally {
          if (projects?.getCurrent() === projectRef.current) {
            const current = projectRef.current;
            if (
              current?.phase === 'registered' &&
              projects.getRetained?.(current.task_id!) === current
            ) {
              projects.suspend();
            } else {
              projects?.dispose();
            }
          }
        }
      }
    };
  }, [projects, tasks, publisher]);

  const register = async (project: LocalProject) => {
    if (!projects || !tasks || !runtime) {
      throw new Error('业务服务尚未初始化');
    }
    setStatus('registering');
    if (projects.getCurrent() !== project && projects.getRetained?.(project.task_id!) === project) {
      projects.activate(project.task_id!);
    }
    if (preparedRef.current?.project !== project) {
      preparedRef.current?.scope.release();
      preparedRef.current = {
        project,
        scope: DicomMetadataStore.prepareLocalImportScope(
          project.batch_id,
          project.successes.map(item => item.dataset)
        ),
      };
    }
    await tasks.register(project);
    visitController.current?.abort();
    const visit = new AbortController();
    visitController.current = visit;
    if (!business?.taskStorage) await tasks.visit?.(project.task_id!, visit.signal);
    if (!mounted.current || !projects.isCurrent(project)) {
      return;
    }
    const { scope } = preparedRef.current;
    let handle: ProjectLifecycleHandle | undefined;
    try {
      projects.retain?.(project);
      scope.activate();
      handle = runtime.bind(project, scope);
      // 共享存储是独立增量；失败／慢写不阻塞原导航与事件桥接。
      void publisher?.publish(project).catch(() => undefined);
      const query = new URLSearchParams();
      project.study_uids.forEach(uid => query.append('StudyInstanceUIDs', uid));
      query.append('datasources', 'dicomlocal');
      if (project.source_stored && project.task_id) query.set('task_id', project.task_id);
      transferred.current = true;
      navigate(`/${project.mode_path}?${query.toString()}`, {
        state: { phaseOneMask: true, taskReturnTo },
      });
    } catch (error) {
      transferred.current = false;
      publisher?.cancel(project);
      try {
        if (handle) {
          handle.releaseScope();
        } else {
          scope.release();
          if (projects.getCurrent() === project) {
            projects.suspend?.();
          }
        }
      } finally {
        preparedRef.current = null;
      }
      throw error;
    }
  };
  const run = async (input?: ImportSelection, teamId?: string) => {
    if (input && input.files.length === 0) {
      return;
    }
    if (locked.current || transferred.current || !projects || !tasks || !runtime) {
      return;
    }
    locked.current = true;
    ownsAttempt.current = true;
    setError('');
    try {
      let project = projectRef.current;
      if (input) {
        setStatus('parsing');
        setFailures([]);
        setRetryProject(null);
        if (project) {
          tasks.cancel(project);
        }
        preparedRef.current?.scope.release();
        preparedRef.current = null;
        projectRef.current = null;
        publicationRef.current?.cancel();
        publicationRef.current = publisher?.prepare(input) ?? null;
        project = await projects.create(
          input,
          microscopyLoaded,
          teamId === undefined ? undefined : { teamId }
        );
        if (!mounted.current) {
          publicationRef.current?.cancel();
          return;
        }
        setFailures(projects.getFailures());
        if (!project) {
          publicationRef.current?.cancel();
          setError('本批次没有可用影像或身份已变化，请重新选择。');
          return;
        }
        projectRef.current = project;
        publicationRef.current?.attach(project);
        if (project.failures.length) {
          uiNotificationService?.show({
            title: '部分文件导入失败',
            message: project.failures.map(item => item.file_name).join('、'),
            type: 'warning',
            duration: 10000,
          });
        }
      }
      if (project) {
        await register(project);
      }
    } catch (error) {
      if (mounted.current) {
        if (!projectRef.current) {
          publicationRef.current?.cancel();
        }
        setError(error instanceof Error ? error.message : '导入或登记失败，请重试');
        const project = projectRef.current;
        setRetryProject(
          project &&
            (projects.isCurrent(project) || projects.getRetained?.(project.task_id!) === project)
            ? project
            : null
        );
      }
    } finally {
      locked.current = false;
      if (mounted.current) {
        setStatus('idle');
      }
    }
  };
  return {
    run,
    busy,
    status,
    error,
    setError,
    failures,
    retryProject,
    available: !!(projects && tasks && runtime),
  };
}
