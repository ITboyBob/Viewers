import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsList, TabsTrigger } from '../Tabs';
import { Slider } from '../Slider';
import { Icons } from '../Icons';
import { Switch } from '../Switch';
import { Label } from '../Label';
import { Input } from '../Input';
import { useSegmentationTableContext } from './contexts';

function AppearanceNumber({ value, min, max, disabled, label, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const number = Number(draft);
    if (draft.trim() && Number.isFinite(number) && number >= min && number <= max) onCommit(number);
    else setDraft(String(value));
  };
  return (
    <Input
      type="number"
      aria-label={label}
      className="mx-1 w-14 flex-none text-center"
      min={min}
      max={max}
      step={0.1}
      value={draft}
      disabled={disabled}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') setDraft(String(value));
      }}
    />
  );
}

export const SegmentationTableConfig: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation('SegmentationTable.AppearanceSettings');
  const {
    renderFill,
    renderOutline,
    setRenderFill,
    setRenderOutline,
    activeRepresentation,
    fillAlpha,
    fillAlphaInactive,
    outlineWidth,
    setFillAlpha,
    setFillAlphaInactive,
    setOutlineWidth,
    renderInactiveSegmentations,
    toggleRenderInactiveSegmentations,
    data,
    appearanceScope,
    appearanceTarget,
    appearanceDisabledReason,
  } = useSegmentationTableContext('SegmentationTableConfig');
  if (!data?.length) return null;
  const perMask = appearanceScope === 'segment';
  const disabled =
    !activeRepresentation || Boolean(appearanceDisabledReason) || (perMask && !appearanceTarget);
  const specifier = {
    type: activeRepresentation?.type,
    segmentationId: appearanceTarget?.segmentationId,
    segmentIndex: appearanceTarget?.segmentIndex,
  };
  const targetKey = (appearanceTarget?.segmentationId || '') + ':' + appearanceTarget?.segmentIndex;
  const mode =
    renderFill && renderOutline ? 'fill-and-outline' : renderOutline ? 'outline' : 'fill';

  return (
    <section
      aria-label={t('Mask appearance settings')}
      className="bg-muted mb-0.5 space-y-2 rounded-b px-1.5 pt-0.5 pb-3"
    >
      {perMask && (
        <div
          className="bg-primary-dark my-2 rounded px-2 py-2 text-xs text-white"
          aria-live="polite"
        >
          {appearanceTarget ? (
            <>
              <span
                aria-hidden="true"
                className="mr-2 inline-block h-3 w-3 rounded-sm align-middle"
                style={{ backgroundColor: appearanceTarget.color }}
              />
              {t('Current Mask')}: {appearanceTarget.segmentIndex} · {appearanceTarget.label}
              <p className="text-muted-foreground mt-1 text-[11px]">
                {t('Applies only to this Mask in 2D slices')}
              </p>
            </>
          ) : (
            t('Select a Mask to adjust its appearance')
          )}
        </div>
      )}
      {appearanceDisabledReason && (
        <p
          role="status"
          className="text-muted-foreground px-1 text-xs"
        >
          {appearanceDisabledReason}
        </p>
      )}
      <div className="my-1 space-y-2">
        <span className="text-aqua-pale text-xs">
          {t('Show')}:{' '}
          {renderFill && renderOutline
            ? t('Fill & Outline')
            : renderOutline
              ? t('Outline Only')
              : t('Fill Only')}
        </span>
        <Tabs
          value={mode}
          onValueChange={value => {
            if (disabled) return;
            setRenderFill(specifier, value !== 'outline');
            setRenderOutline(specifier, value !== 'fill');
          }}
        >
          <TabsList className="flex w-full">
            <TabsTrigger
              disabled={disabled}
              value="fill-and-outline"
              aria-label={t('Fill & Outline')}
              title={t('Fill & Outline')}
              className="flex-1 gap-1 px-1 text-[11px]"
            >
              <Icons.FillAndOutline
                aria-hidden="true"
                className="text-primary h-4 w-4"
              />
              {t('Fill & Outline')}
            </TabsTrigger>
            <TabsTrigger
              disabled={disabled}
              value="outline"
              aria-label={t('Outline Only')}
              title={t('Outline Only')}
              className="flex-1 gap-1 px-1 text-[11px]"
            >
              <Icons.OutlineOnly
                aria-hidden="true"
                className="text-primary h-4 w-4"
              />
              {t('Outline Only')}
            </TabsTrigger>
            <TabsTrigger
              disabled={disabled}
              value="fill"
              aria-label={t('Fill Only')}
              title={t('Fill Only')}
              className="flex-1 gap-1 px-1 text-[11px]"
            >
              <Icons.FillOnly
                aria-hidden="true"
                className="text-primary h-4 w-4"
              />
              {t('Fill Only')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="space-y-2">
        <div className="my-2 flex items-center">
          <Label className="text-muted-foreground w-20 flex-none whitespace-nowrap text-xs">
            {t('Opacity')}
          </Label>
          <Slider
            aria-label={t('Mask fill opacity slider')}
            className="mx-1 flex-1"
            value={[fillAlpha]}
            disabled={disabled || !renderFill}
            onValueChange={([value]) => setFillAlpha(specifier, value)}
            max={1}
            min={0}
            step={0.1}
          />
          <AppearanceNumber
            key={targetKey + ':opacity'}
            label={t('Mask fill opacity')}
            value={fillAlpha}
            min={0}
            max={1}
            disabled={disabled || !renderFill}
            onCommit={value => setFillAlpha(specifier, value)}
          />
        </div>
        {!renderFill && (
          <p className="text-muted-foreground px-1 text-[11px]">
            {t('Fill opacity applies when filling is enabled')}
          </p>
        )}
        <div className="my-2 flex items-center">
          <Label className="text-muted-foreground w-20 flex-none whitespace-nowrap text-xs">
            {t('Border')}
          </Label>
          <Slider
            aria-label={t('Mask outline width slider')}
            className="mx-1 flex-1"
            value={[outlineWidth]}
            disabled={disabled || !renderOutline}
            onValueChange={([value]) => setOutlineWidth(specifier, value)}
            max={10}
            min={0}
            step={0.1}
          />
          <AppearanceNumber
            key={targetKey + ':width'}
            label={t('Mask outline width')}
            value={outlineWidth}
            min={0}
            max={10}
            disabled={disabled || !renderOutline}
            onCommit={value => setOutlineWidth(specifier, value)}
          />
        </div>
      </div>
      {!perMask && (
        <>
          <div className="border-input w-full border" />
          <div className="my-2 flex items-center pl-1">
            <Switch
              aria-label={t('Display inactive segmentations')}
              checked={renderInactiveSegmentations}
              onCheckedChange={toggleRenderInactiveSegmentations}
            />
            <Label className="text-muted-foreground mx-2 text-xs">
              {t('Display inactive segmentations')}
            </Label>
          </div>
          {renderInactiveSegmentations && (
            <div className="my-2 flex items-center">
              <Label className="text-muted-foreground w-20 flex-none whitespace-nowrap text-xs">
                {t('Opacity')}
              </Label>
              <Slider
                aria-label={t('Inactive segmentation opacity')}
                className="mx-1 flex-1"
                value={[fillAlphaInactive]}
                onValueChange={([value]) => setFillAlphaInactive(specifier, value)}
                max={1}
                min={0}
                step={0.1}
              />
              <AppearanceNumber
                label={t('Inactive segmentation opacity')}
                value={fillAlphaInactive}
                min={0}
                max={1}
                disabled={false}
                onCommit={value => setFillAlphaInactive(specifier, value)}
              />
            </div>
          )}
        </>
      )}
      {children}
    </section>
  );
};
