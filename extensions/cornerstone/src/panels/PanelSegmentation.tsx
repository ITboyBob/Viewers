import React, { useEffect, useState } from 'react';
import useTaskReadOnly from '../hooks/useTaskReadOnly';
import useCanAddSegmentation from '../hooks/useCanAddSegmentation';
import { SegmentationTable } from '@ohif/ui-next';
import { useActiveViewportSegmentationRepresentations } from '../hooks/useActiveViewportSegmentationRepresentations';
import { metaData, cache } from '@cornerstonejs/core';
import { useSystem } from '@ohif/core/src';

export default function PanelSegmentation({
  children,
  title = 'Segmentations',
  allViewports = false,
}: withAppTypes<{ children?: React.ReactNode; title?: string; allViewports?: boolean }>) {
  const { commandsManager, servicesManager } = useSystem();
  const readOnly = useTaskReadOnly();
  const canAddSegmentation = useCanAddSegmentation();
  const {
    customizationService,
    segmentationService,
    displaySetService,
    viewportGridService,
    cornerstoneViewportService,
  } = servicesManager.services;

  const { segmentationsWithRepresentations: representationRows, disabled } =
    useActiveViewportSegmentationRepresentations();
  const activeViewportId = viewportGridService.getActiveViewportId();
  const [readyViewportId, setReadyViewportId] = useState<string>();
  useEffect(() => {
    const update = () => {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
      const displaySetId = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId)?.[0];
      const displaySet = displaySetId && displaySetService.getDisplaySetByUID(displaySetId);
      setReadyViewportId(displaySet?.imageIds?.length && viewport ? activeViewportId : undefined);
    };
    const subscription = cornerstoneViewportService.subscribe(
      cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
      update
    );
    update();
    return () => subscription.unsubscribe();
  }, [activeViewportId, cornerstoneViewportService, displaySetService, viewportGridService]);
  const currentViewport = cornerstoneViewportService.getCornerstoneViewport(
    viewportGridService.getActiveViewportId()
  );
  const preferredType = currentViewport?.type === 'volume3d' ? 'Surface' : 'Labelmap';
  const unique = new Map<string, (typeof representationRows)[number]>();
  representationRows.forEach(row => {
    if (!unique.has(row.segmentation.segmentationId) || row.representation.type === preferredType)
      unique.set(row.segmentation.segmentationId, row);
  });
  const segmentationsWithRepresentations = [...unique.values()];
  const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
  const activeSegment = segmentationService.getActiveSegment(activeViewportId);
  const appearanceRepresentation = segmentationsWithRepresentations.find(
    row => row.segmentation.segmentationId === activeSegmentation?.segmentationId
  )?.representation;
  const color =
    activeSegment && activeSegmentation
      ? segmentationService.getSegmentColor(
          activeViewportId,
          activeSegmentation.segmentationId,
          activeSegment.segmentIndex
        )
      : undefined;
  const appearanceTarget =
    activeSegmentation && activeSegment
      ? {
          segmentationId: activeSegmentation.segmentationId,
          segmentIndex: activeSegment.segmentIndex,
          label: activeSegment.label,
          color: color ? `rgb(${color[0]}, ${color[1]}, ${color[2]})` : 'transparent',
        }
      : undefined;
  const appearanceStyle =
    allViewports && appearanceTarget && appearanceRepresentation?.type === 'Labelmap'
      ? segmentationService.getStyle({
          viewportId: activeViewportId,
          segmentationId: appearanceTarget.segmentationId,
          segmentIndex: appearanceTarget.segmentIndex,
          type: appearanceRepresentation.type,
        })
      : undefined;
  const setAppearance = (specifier, key: string, value: number | boolean) => {
    if (allViewports) {
      if (!specifier.segmentationId || !specifier.segmentIndex) return;
      commandsManager.run('setMaskAppearance', { ...specifier, style: { [key]: value } });
    } else {
      commandsManager.run('setSegmentationStyle', { ...specifier, key, value });
    }
  };

  // Extract customization options
  const segmentationTableMode = customizationService.getCustomization(
    'panelSegmentation.tableMode'
  ) as unknown as string;
  const onSegmentationAdd = customizationService.getCustomization(
    'panelSegmentation.onSegmentationAdd'
  );
  const disableEditing = customizationService.getCustomization('panelSegmentation.disableEditing');
  const showAddSegment = customizationService.getCustomization('panelSegmentation.showAddSegment');
  const CustomDropdownMenuContent = customizationService.getCustomization(
    'panelSegmentation.customDropdownMenuContent'
  ) as unknown as React.ComponentType;

  const CustomSegmentStatisticsHeader = customizationService.getCustomization(
    'panelSegmentation.customSegmentStatisticsHeader'
  ) as unknown as React.ComponentType;

  // Create handlers object for all command runs
  const handlers = {
    onSegmentationClick: (segmentationId: string) => {
      commandsManager.run('setActiveSegmentation', { segmentationId });
    },
    onSegmentAdd: segmentationId => {
      commandsManager.run('addSegment', { segmentationId });
    },
    onSegmentClick: (segmentationId, segmentIndex) => {
      commandsManager.run('setActiveSegmentAndCenter', {
        segmentationId,
        segmentIndex,
        highlightSegment: !allViewports,
      });
    },
    onSegmentEdit: (segmentationId, segmentIndex) => {
      commandsManager.run('editSegmentLabel', { segmentationId, segmentIndex });
    },
    onSegmentationEdit: segmentationId => {
      commandsManager.run('editSegmentationLabel', { segmentationId });
    },
    onSegmentColorClick: (segmentationId, segmentIndex) => {
      commandsManager.run('editSegmentColor', { segmentationId, segmentIndex, allViewports });
    },
    onSegmentDelete: (segmentationId, segmentIndex) => {
      commandsManager.run('deleteSegment', { segmentationId, segmentIndex });
    },
    onToggleSegmentVisibility: (segmentationId, segmentIndex, type) => {
      commandsManager.run('toggleSegmentVisibility', {
        segmentationId,
        segmentIndex,
        type,
        allViewports,
      });
    },
    onToggleSegmentLock: (segmentationId, segmentIndex) => {
      commandsManager.run('toggleSegmentLock', { segmentationId, segmentIndex });
    },
    onToggleSegmentationRepresentationVisibility: (segmentationId, type) => {
      commandsManager.run('toggleSegmentationVisibility', { segmentationId, type, allViewports });
    },
    onSegmentationDownload: segmentationId => {
      commandsManager.run('downloadSegmentation', { segmentationId });
    },
    setStyle: (segmentationId, type, key, value) => {
      commandsManager.run('setSegmentationStyle', { segmentationId, type, key, value });
    },
    toggleRenderInactiveSegmentations: () => {
      commandsManager.run('toggleRenderInactiveSegmentations');
    },
    onSegmentationRemoveFromViewport: segmentationId => {
      commandsManager.run('removeSegmentationFromViewport', { segmentationId });
    },
    onSegmentationDelete: segmentationId => {
      commandsManager.run('deleteSegmentation', { segmentationId });
    },
    setFillAlpha: (specifier, value) => {
      setAppearance(specifier, 'fillAlpha', value);
    },
    setOutlineWidth: (specifier, value) => {
      setAppearance(specifier, 'outlineWidth', value);
    },
    setRenderFill: (specifier, value) => {
      setAppearance(specifier, 'renderFill', value);
    },
    setRenderOutline: (specifier, value) => {
      setAppearance(specifier, 'renderOutline', value);
    },
    setFillAlphaInactive: ({ type }, value) => {
      commandsManager.run('setFillAlphaInactive', { type, value });
    },
    getRenderInactiveSegmentations: () => {
      return commandsManager.run('getRenderInactiveSegmentations');
    },
  };

  // Generate export options
  const exportOptions = segmentationsWithRepresentations.map(({ segmentation }) => {
    const { representationData, segmentationId } = segmentation;
    const { Labelmap } = representationData;

    if (!Labelmap) {
      return { segmentationId, isExportable: true };
    }
    const labelmap = Labelmap as {
      imageIds?: string[];
      volumeId?: string;
      referencedImageIds?: string[];
    };
    const volume = labelmap.volumeId ? cache.getVolume(labelmap.volumeId) : undefined;
    const imageIds = labelmap.imageIds || volume?.imageIds || [];

    // Check if any segments have anything drawn in any of the viewports
    const hasAnySegmentData = (() => {
      if (!imageIds?.length) return false;

      for (const imageId of imageIds) {
        const pixelData = cache.getImage(imageId)?.getPixelData();
        if (!pixelData) continue;

        for (let i = 0; i < pixelData.length; i++) {
          if (pixelData[i] !== 0) return true;
        }
      }
      return false;
    })();

    if (!hasAnySegmentData) {
      return { segmentationId, isExportable: false };
    }

    const firstImageId =
      labelmap.referencedImageIds?.[0] ||
      cache.getImage(imageIds[0])?.referencedImageId ||
      volume?.referencedImageIds?.[0];
    if (!firstImageId) return { segmentationId, isExportable: false };
    const instance = metaData.get('instance', firstImageId);

    if (!instance) {
      return { segmentationId, isExportable: false };
    }

    const SOPInstanceUID = instance.SOPInstanceUID || instance.SopInstanceUID;
    const SeriesInstanceUID = instance.SeriesInstanceUID;
    const displaySet = displaySetService.getDisplaySetForSOPInstanceUID(
      SOPInstanceUID,
      SeriesInstanceUID
    );

    return {
      segmentationId,
      isExportable: displaySet?.isReconstructable,
    };
  });

  // Common props for SegmentationTable
  const tableProps = {
    disabled: disabled || !readyViewportId || readyViewportId !== activeViewportId,
    addSegmentationDisabled: !canAddSegmentation,
    data: segmentationsWithRepresentations,
    mode: segmentationTableMode,
    title,
    ...(allViewports
      ? {
          appearanceScope: 'segment' as const,
          appearanceTarget,
          appearanceStyle,
          appearanceDisabledReason:
            appearanceRepresentation?.type !== 'Labelmap'
              ? '请选择二维切片窗口，设置当前 Mask 的填充与轮廓。'
              : undefined,
        }
      : {}),
    exportOptions,
    disableEditing: disableEditing || readOnly,
    onSegmentationAdd,
    showAddSegment,
    renderInactiveSegmentations: handlers.getRenderInactiveSegmentations(),
    ...handlers,
  };

  const renderSegments = () => {
    return (
      <SegmentationTable.Segments>
        <SegmentationTable.SegmentStatistics.Header>
          <CustomSegmentStatisticsHeader />
        </SegmentationTable.SegmentStatistics.Header>
        <SegmentationTable.SegmentStatistics.Body />
      </SegmentationTable.Segments>
    );
  };

  // Render content based on mode
  const renderModeContent = () => {
    if (tableProps.mode === 'collapsed') {
      return (
        <SegmentationTable.Collapsed>
          <SegmentationTable.Collapsed.Header>
            <SegmentationTable.Collapsed.DropdownMenu>
              <CustomDropdownMenuContent />
            </SegmentationTable.Collapsed.DropdownMenu>
            <SegmentationTable.Collapsed.Selector />
            <SegmentationTable.Collapsed.Info />
          </SegmentationTable.Collapsed.Header>
          <SegmentationTable.Collapsed.Content>
            <SegmentationTable.AddSegmentRow />
            {renderSegments()}
          </SegmentationTable.Collapsed.Content>
        </SegmentationTable.Collapsed>
      );
    }

    return (
      <>
        <SegmentationTable.Expanded>
          <SegmentationTable.Expanded.Header>
            <SegmentationTable.Expanded.DropdownMenu>
              <CustomDropdownMenuContent />
            </SegmentationTable.Expanded.DropdownMenu>
            <SegmentationTable.Expanded.Label />
            <SegmentationTable.Expanded.Info />
          </SegmentationTable.Expanded.Header>

          <SegmentationTable.Expanded.Content>
            <SegmentationTable.AddSegmentRow />
            {renderSegments()}
          </SegmentationTable.Expanded.Content>
        </SegmentationTable.Expanded>
      </>
    );
  };

  return (
    <fieldset
      disabled={readOnly}
      style={{ minWidth: 0, border: 0, padding: 0, margin: 0 }}
    >
      <SegmentationTable {...tableProps}>
        {children}
        <SegmentationTable.Config />
        <SegmentationTable.AddSegmentationRow />
        {renderModeContent()}
      </SegmentationTable>
    </fieldset>
  );
}
