import React, { useRef } from 'react';
import { useSystem } from '@ohif/core';
import type { BusinessServices } from '@ohif/core';
import useLocalTaskImport from '../Local/useLocalTaskImport';

type Props = { services: BusinessServices; teamId?: string };

/** 文件选择前冻结目标；不更改会话当前团队，也不经过导入页跳转。 */
export default function CreateTaskButton({ services, teamId }: Props) {
  const system = useSystem();
  const input = useRef<HTMLInputElement>(null);
  const selectedTeam = useRef<string | null>(null);
  const importer = useLocalTaskImport(
    services,
    system?.extensionManager?.registeredExtensionIds.includes('@ohif/extension-dicom-microscopy') ??
      false,
    system?.servicesManager?.services.uiNotificationService
  );
  const disabled = !teamId || !importer.available || importer.busy;
  return (
    <div className="team-page-create">
      <button
        type="button"
        className="team-page-create-button"
        disabled={disabled}
        onClick={() => {
          if (disabled) {
            return;
          }
          selectedTeam.current = teamId!;
          input.current?.click();
        }}
      >
        创建新任务
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="创建任务文件"
        disabled={disabled}
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          const target = selectedTeam.current;
          selectedTeam.current = null;
          if (files.length && target) {
            void importer.run({ files, kind: 'files' }, target);
          }
        }}
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
