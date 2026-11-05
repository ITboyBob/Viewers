import React from 'react';
import { Icons } from '../Icons';
import { useTranslation } from 'react-i18next';
import { useSegmentationTableContext } from './contexts';

export const AddSegmentationRow: React.FC<{ children?: React.ReactNode }> = ({
  children = null,
}) => {
  const { t } = useTranslation('SegmentationTable');
  const {
    onSegmentationAdd,
    data,
    disableEditing,
    mode,
    disabled,
    addSegmentationDisabled = false,
  } = useSegmentationTableContext('AddSegmentationRow');
  if ((data.length !== 0 && mode === 'collapsed') || disableEditing) {
    return null;
  }
  const blocked = disabled || addSegmentationDisabled;
  return (
    <button
      type="button"
      data-cy="addSegmentation"
      disabled={blocked}
      className={`group w-full text-left ${blocked ? 'cursor-not-allowed opacity-70 hover:opacity-50' : ''}`}
      title={addSegmentationDisabled ? '当前工作台无新增分割权限' : undefined}
      onClick={() => {
        if (!blocked) {
          onSegmentationAdd?.('');
        }
      }}
    >
      {children}
      <span
        className={`text-primary flex items-center rounded-[4px] pl-1 ${blocked ? 'cursor-not-allowed' : 'group-hover:bg-secondary-dark group-hover:cursor-pointer'}`}
      >
        <span className="grid h-[28px] w-[28px] place-items-center">
          {disabled ? <Icons.Info /> : <Icons.Add />}
        </span>
        <span className="text-[13px]">
          {t(disabled ? 'Segmentation Not Supported' : 'Add Segmentation')}
        </span>
      </span>
    </button>
  );
};
