import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Close from '../../../../ui-next/src/components/Icons/Sources/Close';
import '../../routes/Account/AccountFonts.css';
import './BusinessDialogs.css';
import './BusinessFonts.css';

const isolateFileDrag = (event: React.DragEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

/** 复用项目 Radix overlay 模式：Portal、焦点约束／恢复、外部点击和 Escape 关闭。 */
export default function BusinessDialog({
  title,
  trigger,
  open,
  onOpenChange,
  variant,
  children,
}: React.PropsWithChildren<{
  title: string;
  trigger: React.ReactElement;
  open: boolean;
  onOpenChange(open: boolean): void;
  variant: 'invite' | 'notifications' | 'members';
}>) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
    >
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          className="business-dialog-backdrop"
          onClick={event => event.stopPropagation()}
          onDragEnter={isolateFileDrag}
          onDragOver={isolateFileDrag}
          onDrop={isolateFileDrag}
        />
        <Dialog.Content
          className={`business-dialog business-dialog--${variant}`}
          aria-describedby={undefined}
          onCloseAutoFocus={() => {
            // 切队销毁触发器时，默认焦点恢复无目标；落到新页面主区。
            setTimeout(() => {
              if (document.activeElement === document.body)
                document.querySelector<HTMLElement>('.team-page-main')?.focus();
            }, 0);
          }}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          onDragEnter={isolateFileDrag}
          onDragOver={isolateFileDrag}
          onDrop={isolateFileDrag}
        >
          <div className="business-dialog-titlebar">
            <Dialog.Title className="business-dialog-title">{title}</Dialog.Title>
            <Dialog.Close
              className="business-top-action business-dialog-close"
              aria-label={
                variant === 'invite'
                  ? '关闭邀请弹窗'
                  : variant === 'members'
                    ? '关闭成员弹窗'
                    : '关闭通知弹窗'
              }
            >
              <Close aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="business-dialog-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
