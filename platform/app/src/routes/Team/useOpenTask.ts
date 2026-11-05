import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { DicomMetadataStore } from '@ohif/core';
import type { BusinessServices, ProjectLifecycleHandle } from '@ohif/core';

/** 优先从后端恢复授权任务；原图未准备好时绝不创建空工作台或重登记。 */
export default function useOpenTask(services: BusinessServices) {
  const navigate = useNavigate(),
    location = useLocation();
  const [opening, setOpening] = useState<string | null>(null),
    [error, setError] = useState('');
  const busy = useRef(false),
    mounted = useRef(true),
    controller = useRef<AbortController>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const open = async (taskId: string, signal?: AbortSignal): Promise<boolean> => {
    if (busy.current || signal?.aborted) {
      return false;
    }
    busy.current = true;
    setOpening(taskId);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const projects = services.localProjects,
      runtime = services.projectRuntime;
    let project = projects?.getRetained?.(taskId);
    let scope: ReturnType<typeof DicomMetadataStore.prepareLocalImportScope> | undefined;
    let handle: ProjectLifecycleHandle | undefined;
    let transferred = false;
    const eligible = () =>
      mounted.current && !abort.signal.aborted && projects?.getRetained?.(taskId) === project;
    try {
      if (runtime?.getCurrent?.()?.task_id !== taskId) {
        runtime?.prepareSuspend?.();
      }
      if (services.taskStorage) project = await services.taskStorage.open(taskId, abort.signal);
      if (!project || !projects || !runtime || !services.tasks || !services.teamPage) {
        throw new Error('当前页面未保留该任务影像，需重新导入；重新导入会创建新任务。');
      }
      await services.teamPage.listTaskMembers(taskId, abort.signal);
      if (!eligible()) {
        return false;
      }
      if (!services.taskStorage) await services.tasks.visit(taskId, abort.signal);
      if (!eligible()) {
        return false;
      }
      projects.activate(taskId);
      scope = DicomMetadataStore.prepareLocalImportScope(
        project.batch_id,
        project.successes.map(item => item.dataset)
      );
      scope.activate();
      handle = runtime.bind(project, scope);
      const selection = projects.getSelection(project);
      if (selection) {
        services.localCollaboration?.publisher?.prepare(selection).attach(project);
        void services.localCollaboration?.publisher?.publish(project).catch(() => undefined);
      }
      const query = new URLSearchParams();
      project.study_uids.forEach(uid => query.append('StudyInstanceUIDs', uid));
      query.set('datasources', 'dicomlocal');
      if (project.source_stored && project.task_id) query.set('task_id', project.task_id);
      navigate(`/${project.mode_path}?${query}`, {
        state: {
          phaseOneMask: true,
          taskReturnTo: location.pathname === '/team/recent' ? '/team/recent' : '/team/tasks',
        },
      });
      transferred = true;
      return true;
    } catch (reason) {
      if (mounted.current && !abort.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '任务打开失败，请重试。');
      }
      return false;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!transferred && project) {
        if (handle) {
          handle.releaseScope();
        } else {
          scope?.release();
          if (projects?.getCurrent() === project) {
            projects.suspend();
          }
        }
      }
      busy.current = false;
      if (mounted.current) {
        setOpening(null);
      }
    }
  };
  return { open, opening, error };
}
