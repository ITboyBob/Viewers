import React, { useRef } from 'react';
import { useSystem } from '@ohif/core';
import type { BusinessServices, ImportSelection } from '@ohif/core';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@ohif/ui-next/components/DropdownMenu/DropdownMenu';
import useLocalTaskImport from '../Local/useLocalTaskImport';

type Props = { services: BusinessServices; teamId?: string };

/** 文件选择前冻结目标；不更改会话当前团队，也不经过导入页跳转。 */
export default function CreateTaskButton({ services, teamId }: Props) {
  const system = useSystem();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const selectedTeam = useRef<string | null>(null);
  const importer = useLocalTaskImport(
    services,
    system?.extensionManager?.registeredExtensionIds.includes('@ohif/extension-dicom-microscopy') ??
      false,
    system?.servicesManager?.services.uiNotificationService
  );
  const disabled = !teamId || !importer.available || importer.busy;
  const openPicker = (kind: ImportSelection['kind']) => {
    if (disabled) {
      return;
    }
    selectedTeam.current = teamId!;
    (kind === 'folder' ? folderInput : filesInput).current?.click();
  };
  const handleSelection = (
    event: React.ChangeEvent<HTMLInputElement>,
    kind: ImportSelection['kind']
  ) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    const target = selectedTeam.current;
    selectedTeam.current = null;
    if (!disabled && files.length && target) {
      void importer.run({ files, kind }, target);
    }
  };
  return (
    <div className="team-page-create">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="team-page-create-button"
            disabled={disabled}
          >
            创建新任务
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={disabled}
            onSelect={() => openPicker('files')}
          >
            选择文件
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={disabled}
            onSelect={() => openPicker('folder')}
          >
            选择文件夹
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        aria-label="创建任务文件"
        disabled={disabled}
        onChange={event => handleSelection(event, 'files')}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: 'true', mozdirectory: 'true' }}
        aria-label="创建任务文件夹"
        disabled={disabled}
        onChange={event => handleSelection(event, 'folder')}
      />
      {importer.busy && (
        <span role="status">{importer.status === 'parsing' ? '正在解析…' : '正在登记…'}</span>
      )}
      {importer.error && <span role="alert">{importer.error}</span>}
      {importer.failures.length > 0 && (
        <span className="team-page-import-failures">
          以下文件导入失败：{importer.failures.map(item => item.file_name).join('、')}
        </span>
      )}
      {importer.retryProject && (
        <button
          type="button"
          className="team-page-refresh"
          disabled={importer.busy}
          onClick={() => void importer.run()}
        >
          重试登记
        </button>
      )}
    </div>
  );
}
