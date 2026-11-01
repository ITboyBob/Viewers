import React, { useEffect, useRef } from 'react';
import type {
  BatchFailure,
  ImportSelection,
  LocalImportScope,
  LocalProject,
  ProjectLifecycleHandle,
  SharedFilePublicationPort,
} from '@ohif/core';
import { useAppConfig } from '@state';
import { useNavigate } from 'react-router-dom';
import { DicomMetadataStore, MODULE_TYPES, useSystem } from '@ohif/core';

import Dropzone from 'react-dropzone';
import filesToStudies from './filesToStudies';

import { extensionManager } from '../../App';

import { Button, Icons } from '@ohif/ui-next';

const getLoadButton = (
  onDrop,
  text,
  isDir,
  options: { disabled?: boolean; label?: string } = {}
) => (
  <Dropzone
    onDrop={onDrop}
    noDrag
    disabled={options.disabled}
  >
    {({ getRootProps, getInputProps }) => (
      <div {...getRootProps()}>
        <Button
          variant="default"
          className="w-28"
          disabled={options.disabled ?? false}
          onClick={() => {}}
        >
          {text}
          <input
            {...getInputProps()}
            {...(isDir ? { webkitdirectory: 'true', mozdirectory: 'true' } : {})}
            aria-label={options.label}
            style={{ display: 'none' }}
          />
        </Button>
      </div>
    )}
  </Dropzone>
);

type LocalProps = {
  modePath: string;
  phaseOneMask?: boolean;
};

function NativeLocal({ modePath }: LocalProps) {
  const { servicesManager } = useSystem();
  const { customizationService } = servicesManager.services;
  const navigate = useNavigate();
  const dropzoneRef = useRef();
  const [dropInitiated, setDropInitiated] = React.useState(false);

  const LoadingIndicatorProgress = customizationService.getCustomization(
    'ui.loadingIndicatorProgress'
  ) as React.ComponentType<{ className?: string }>;

  // Initializing the dicom local dataSource
  const dataSourceModules = extensionManager.modules[MODULE_TYPES.DATA_SOURCE];
  const localDataSources = dataSourceModules.reduce((acc, curr) => {
    const mods = [];
    curr.module.forEach(mod => {
      if (mod.type === 'localApi') {
        mods.push(mod);
      }
    });
    return acc.concat(mods);
  }, []);

  const firstLocalDataSource = localDataSources[0];
  firstLocalDataSource.createDataSource({});

  const microscopyExtensionLoaded = extensionManager.registeredExtensionIds.includes(
    '@ohif/extension-dicom-microscopy'
  );

  const onDrop = async acceptedFiles => {
    const studies = await filesToStudies(acceptedFiles);

    const query = new URLSearchParams();

    if (microscopyExtensionLoaded) {
      // TODO: for microscopy, we are forcing microscopy mode, which is not ideal.
      //     we should make the local drag and drop navigate to the worklist and
      //     there user can select microscopy mode
      const smStudies = studies.filter(id => {
        const study = DicomMetadataStore.getStudy(id);
        return (
          study.series.findIndex(s => s.Modality === 'SM' || s.instances[0].Modality === 'SM') >= 0
        );
      });

      if (smStudies.length > 0) {
        smStudies.forEach(id => query.append('StudyInstanceUIDs', id));

        modePath = 'microscopy';
      }
    }

    // Todo: navigate to work list and let user select a mode
    studies.forEach(id => query.append('StudyInstanceUIDs', id));
    query.append('datasources', 'dicomlocal');

    navigate(`/${modePath}?${decodeURIComponent(query.toString())}`);
  };

  // Set body style
  useEffect(() => {
    document.body.classList.add('bg-black');
    return () => {
      document.body.classList.remove('bg-black');
    };
  }, []);

  return (
    <Dropzone
      ref={dropzoneRef}
      onDrop={acceptedFiles => {
        setDropInitiated(true);
        onDrop(acceptedFiles);
      }}
      noClick
    >
      {({ getRootProps }) => (
        <div
          {...getRootProps()}
          style={{ width: '100%', height: '100%' }}
        >
          <div className="flex h-screen w-screen items-center justify-center">
            <div className="bg-muted border-primary/60 mx-auto space-y-2 rounded-xl border border-dashed py-12 px-12 drop-shadow-md">
              <div className="flex items-center justify-center">
                <Icons.OHIFLogoColorDarkBackground className="h-18" />
              </div>
              <div className="space-y-2 py-6 text-center">
                {dropInitiated ? (
                  <div className="flex flex-col items-center justify-center pt-12">
                    <LoadingIndicatorProgress className={'h-full w-full bg-black'} />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-primary pt-0 text-xl">
                      Drag and drop your DICOM files & folders here <br />
                      to load them locally.
                    </p>
                    <p className="text-muted-foreground text-base">
                      Note: Your data remains locally within your browser
                      <br /> and is never uploaded to any server.
                    </p>
                  </div>
                )}
              </div>
              <div className="flex justify-center gap-2 pt-4">
                {getLoadButton(onDrop, 'Load files', false)}
                {getLoadButton(onDrop, 'Load folders', true)}
              </div>
            </div>
          </div>
        </div>
      )}
    </Dropzone>
  );
}

type DropInfo = {
  dataTransfer?: {
    items?: Iterable<{
      kind: string;
      webkitGetAsEntry?: () => { isDirectory: boolean; name?: string } | null;
    }>;
  };
};
export function selectionFromDrop(files: readonly File[], event?: unknown): ImportSelection {
  const items = Array.from((event as DropInfo)?.dataTransfer?.items ?? []);
  const entries = items
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean);
  const directories = entries.filter(entry => entry.isDirectory);
  if (directories.length) {
    if (entries.length !== 1 || directories.length !== 1 || !directories[0].name) {
      throw new Error('请重新选择单一文件夹');
    }
    return { files: [...files], kind: 'folder', folderName: directories[0].name };
  }
  return {
    files: [...files],
    kind: files.some(file => !!file.webkitRelativePath) ? 'folder' : 'files',
  };
}

function MaskLocal() {
  const { servicesManager } = useSystem();
  const {
    businessServices: business,
    customizationService,
    uiNotificationService,
  } = servicesManager.services;
  const projects = business?.localProjects,
    tasks = business?.tasks,
    runtime = business?.projectRuntime;
  const publisher = business?.localCollaboration?.publisher;
  const navigate = useNavigate();
  const mounted = useRef(true),
    locked = useRef(false),
    transferred = useRef(false);
  const projectRef = useRef<LocalProject | null>(null);
  const publicationRef = useRef<ReturnType<SharedFilePublicationPort['prepare']> | null>(null);
  const preparedRef = useRef<{ project: LocalProject; scope: LocalImportScope } | null>(null);
  const [status, setStatus] = React.useState<'idle' | 'parsing' | 'registering'>('idle');
  const [error, setError] = React.useState('');
  const [failures, setFailures] = React.useState<readonly BatchFailure[]>([]);
  const [retryProject, setRetryProject] = React.useState<LocalProject | null>(null);
  const busy = status !== 'idle';
  const Loading = customizationService.getCustomization(
    'ui.loadingIndicatorProgress'
  ) as React.ComponentType<{ className?: string }>;
  const microscopyLoaded = extensionManager.registeredExtensionIds.includes(
    '@ohif/extension-dicom-microscopy'
  );

  useEffect(() => {
    mounted.current = true;
    document.body.classList.add('bg-black');
    return () => {
      mounted.current = false;
      document.body.classList.remove('bg-black');
      if (!transferred.current) {
        if (projectRef.current) {
          tasks?.cancel(projectRef.current);
        }
        publicationRef.current?.cancel();
        try {
          preparedRef.current?.scope.release();
        } finally {
          projects?.dispose();
        }
      }
    };
  }, [projects, tasks, publisher]);

  const register = async (project: LocalProject) => {
    if (!projects || !tasks || !runtime) {
      throw new Error('业务服务尚未初始化');
    }
    setStatus('registering');
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
    if (!mounted.current || !projects.isCurrent(project)) {
      return;
    }
    const { scope } = preparedRef.current;
    let handle: ProjectLifecycleHandle | undefined;
    try {
      scope.activate();
      handle = runtime.bind(project, scope);
      // 共享存储是独立增量；失败／慢写不阻塞原导航与事件桥接。
      void publisher?.publish(project).catch(() => undefined);
      const query = new URLSearchParams();
      project.study_uids.forEach(uid => query.append('StudyInstanceUIDs', uid));
      query.append('datasources', 'dicomlocal');
      transferred.current = true;
      navigate(`/${project.mode_path}?${query.toString()}`, { state: { phaseOneMask: true } });
    } catch (error) {
      transferred.current = false;
      publisher?.cancel(project);
      try {
        if (handle) {
          handle.releaseScope();
        } else {
          scope.release();
        }
      } finally {
        preparedRef.current = null;
      }
      throw error;
    }
  };
  const run = async (input?: ImportSelection) => {
    if (locked.current || transferred.current || !projects || !tasks || !runtime) {
      return;
    }
    locked.current = true;
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
        project = await projects.create(input, microscopyLoaded);
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
        setRetryProject(project && projects.isCurrent(project) ? project : null);
      }
    } finally {
      locked.current = false;
      if (mounted.current) {
        setStatus('idle');
      }
    }
  };
  const drop = (files: readonly File[], event?: unknown) => {
    try {
      void run(selectionFromDrop(files, event));
    } catch (error) {
      setError(error instanceof Error ? error.message : '请选择单一文件夹');
    }
  };
  if (!projects || !tasks || !runtime) {
    return <div role="alert">业务服务尚未初始化，不能登记影像。</div>;
  }
  return (
    <>
      {business?.ui && (
        <div className="business-import-header">{business.ui.renderHeader({ page: 'import' })}</div>
      )}
      <Dropzone
        noClick
        disabled={busy}
        onDrop={(files, _rejected, event) => drop(files, event)}
      >
        {({ getRootProps }) => (
          <div
            {...getRootProps()}
            data-testid="mask-import-drop"
            style={{ width: '100%', height: '100%' }}
          >
            <div
              className={`flex w-screen items-center justify-center ${business?.ui ? 'h-[calc(100vh-48px)]' : 'h-screen'}`}
            >
              <div className="bg-muted border-primary/60 mx-auto space-y-2 rounded-xl border border-dashed py-12 px-12 drop-shadow-md">
                <div className="flex items-center justify-center">
                  <Icons.OHIFLogoColorDarkBackground className="h-18" />
                </div>
                <div className="space-y-2 py-6 text-center">
                  <p className="text-primary pt-0 text-xl">
                    Drag and drop your DICOM files &amp; folders here
                    <br />
                    to load them locally.
                  </p>
                  <p className="text-muted-foreground text-base">
                    影像只留在当前浏览器；后端仅登记任务标题与身份。
                  </p>
                  {busy && (
                    <div role="status">
                      <p>{status === 'parsing' ? '正在解析本批次…' : '正在登记任务…'}</p>
                      {Loading && <Loading className="h-full w-full bg-black" />}
                    </div>
                  )}
                  {failures.length > 0 && (
                    <div className="text-left">
                      <p>以下文件导入失败，成功子集将自动继续：</p>
                      <ul>
                        {failures.map(item => (
                          <li key={item.selection_index}>{item.file_name}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {error && <div role="alert">{error}</div>}
                  {retryProject && (
                    <Button
                      disabled={busy}
                      onClick={() => void run()}
                    >
                      重试登记
                    </Button>
                  )}
                </div>
                <div className="flex justify-center gap-2 pt-4">
                  {getLoadButton(files => void run({ files, kind: 'files' }), 'Load files', false, {
                    disabled: busy,
                    label: '导入文件',
                  })}
                  {getLoadButton(
                    files => void run({ files, kind: 'folder' }),
                    'Load folders',
                    true,
                    {
                      disabled: busy,
                      label: '导入文件夹',
                    }
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Dropzone>
    </>
  );
}
export default function Local(props: LocalProps) {
  const [config] = useAppConfig();
  return props.phaseOneMask && config.phaseOneBusiness?.enabled ? (
    <MaskLocal />
  ) : (
    <NativeLocal {...props} />
  );
}
