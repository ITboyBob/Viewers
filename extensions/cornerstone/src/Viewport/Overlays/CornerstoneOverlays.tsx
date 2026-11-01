import React, { useEffect, useReducer, useState } from 'react';
import { Enums } from '@cornerstonejs/core';
import type { StackViewport } from '@cornerstonejs/core';
import type { BusinessServices } from '@ohif/core';
import RemoteCursorOverlay from './RemoteCursorOverlay';
import { RemoteCursorController } from './RemoteCursorController';
import type { RemoteCursorControllerState } from './RemoteCursorController';
import type { StackCursorProjectionContext } from './remoteCursorProjection';

import ViewportImageScrollbar from './ViewportImageScrollbar';
import CustomizableViewportOverlay from './CustomizableViewportOverlay';
import ViewportOrientationMarkers from './ViewportOrientationMarkers';
import ViewportImageSliceLoadingIndicator from './ViewportImageSliceLoadingIndicator';

/** 原生本窗imageId只用于定位本窗文件，通信始终使用稳定选择键／UID／一基帧号。 */
function sharedCursorContext(
  element: HTMLElement,
  viewportId: string,
  servicesManager: AppTypes.ServicesManager,
  business: BusinessServices
): StackCursorProjectionContext {
  const nativeServices = servicesManager.services as unknown as {
    cornerstoneViewportService: { getCornerstoneViewport(id: string): StackViewport | undefined };
  };
  const viewport = nativeServices.cornerstoneViewportService.getCornerstoneViewport(viewportId);
  const viewportSize = { width: element.clientWidth, height: element.clientHeight };
  const empty = {
    viewportType: viewport?.type ?? 'unknown',
    viewportSize,
    frame: null,
    transform: null,
  };
  if (!viewport || viewport.type !== Enums.ViewportType.STACK) {
    return empty;
  }
  const stack = viewport as StackViewport;
  const imageId = stack.getCurrentImageId();
  const loadedImage = stack.getCornerstoneImage();
  // 目标索引先于异步加载改变；只有实际加载图像也匹配时才构造原图坐标。
  if (!loadedImage || loadedImage.imageId !== imageId) {
    return empty;
  }
  const match = /^(dicomfile:(?:0|[1-9][0-9]*))(?:[?&]frame=([1-9][0-9]*))?$/.exec(imageId ?? '');
  const shared = business.localCollaboration;
  const files =
    shared?.participation?.identity.role === 'source'
      ? business.projectRuntime?.getCurrent()?.successes
      : shared?.sharedView?.getSnapshot()?.local_files;
  const file = match && files?.find(item => item.image_id === match[1]);
  if (!file) {
    return empty;
  }
  if (['SEG', 'SR', 'SM'].includes(String(file.dataset.Modality ?? '').toUpperCase())) {
    return empty;
  }
  const first = [...files]
    .filter(
      item =>
        item.study_uid === file.study_uid &&
        item.series_uid === file.series_uid &&
        item.sop_uid === file.sop_uid
    )
    .sort((a, b) => a.selection_index - b.selection_index)[0];
  if (first.image_id !== file.image_id) {
    return empty;
  }
  const frameNumber = match[2] ? Number(match[2]) : 1;
  const frameCount = Number(file.dataset.NumberOfFrames ?? 1);
  const data = stack.getImageData();
  if (
    !Number.isSafeInteger(frameNumber) ||
    !Number.isSafeInteger(frameCount) ||
    frameNumber > frameCount ||
    !data?.imageData ||
    data.dimensions[0] !== loadedImage.columns ||
    data.dimensions[1] !== loadedImage.rows ||
    typeof data.imageData.worldToIndex !== 'function' ||
    typeof data.imageData.indexToWorld !== 'function'
  ) {
    return empty;
  }
  return {
    viewportType: 'stack',
    viewportSize,
    frame: {
      selection_index: file.selection_index,
      study_uid: file.study_uid,
      series_uid: file.series_uid,
      sop_uid: file.sop_uid,
      frame_number: frameNumber,
      columns: loadedImage.columns,
      rows: loadedImage.rows,
    },
    transform: {
      canvasToImage: ({ x, y }) => {
        const index = data.imageData.worldToIndex(stack.canvasToWorld([x, y]));
        return { column: index[0], row: index[1] };
      },
      imageToCanvas: ({ column, row }) => {
        const world = data.imageData.indexToWorld([column, row, 0]);
        const point = stack.worldToCanvas([world[0], world[1], world[2]]);
        return { x: point[0], y: point[1] };
      },
    },
  };
}

function LocalSharingCursors({
  element,
  viewportId,
  servicesManager,
}: {
  element: HTMLElement;
  viewportId: string;
  servicesManager: AppTypes.ServicesManager;
}) {
  const business = servicesManager.services.businessServices;
  const shared = business?.localCollaboration;
  const [, refresh] = useReducer(value => value + 1, 0);
  const [state, setState] = useState<RemoteCursorControllerState | null>(null);
  const participation = shared?.participation;
  useEffect(() => {
    const stops = [shared?.publisher?.subscribe(refresh), shared?.sharedView?.subscribe(refresh)];
    return () => stops.forEach(stop => stop?.());
  }, [shared]);
  useEffect(() => participation?.subscribe(refresh), [participation]);
  const active = participation?.getSnapshot().phase === 'active';
  useEffect(() => {
    if (!shared || !participation || !active) {
      return;
    }
    const source = shared.identities.getSource();
    const generation = shared.sharedView?.getSnapshot()?.load_generation;
    const ready = () => {
      const nativeServices = servicesManager.services as unknown as {
        cornerstoneViewportService: {
          getCornerstoneViewport(id: string): StackViewport | undefined;
        };
      };
      const viewport = nativeServices.cornerstoneViewportService.getCornerstoneViewport(viewportId);
      if (
        viewport?.viewportStatus !== Enums.ViewportStatus.RENDERED ||
        !viewport.getImageData()?.imageData
      ) {
        return;
      }
      if (participation.identity.role === 'source') {
        if (!source?.getSnapshot().view_ready) {
          source?.setViewReady(true);
        }
      } else if (generation !== undefined) {
        shared.sharedView?.markViewReady(generation);
      }
    };
    element.addEventListener(Enums.Events.IMAGE_RENDERED, ready);
    // 首帧可能早于覆盖层挂载；只接纳原生已完成的渲染状态。
    ready();
    return () => element.removeEventListener(Enums.Events.IMAGE_RENDERED, ready);
  }, [shared, participation, active, element, viewportId, servicesManager]);
  useEffect(() => {
    if (!business || !shared || !participation || !active) {
      setState(null);
      return;
    }
    const controller = new RemoteCursorController({
      element,
      participation,
      getContext: () => sharedCursorContext(element, viewportId, servicesManager, business),
      getViewReady: () =>
        participation.identity.role === 'source'
          ? shared.identities.getSource()?.getSnapshot().view_ready === true
          : shared.sharedView?.getSnapshot()?.phase === 'active' &&
            shared.sharedView?.getSnapshot()?.view_ready === true,
      subscribeView: listener => {
        const stops = [
          shared.publisher?.subscribe(listener),
          shared.sharedView?.subscribe(listener),
        ];
        return () => stops.forEach(stop => stop?.());
      },
      onChange: setState,
      events: [
        Enums.Events.CAMERA_MODIFIED,
        Enums.Events.IMAGE_RENDERED,
        Enums.Events.STACK_NEW_IMAGE,
        Enums.Events.PRE_STACK_NEW_IMAGE,
      ],
    });
    return () => {
      controller.dispose();
      setState(null);
    };
  }, [business, shared, participation, active, element, viewportId, servicesManager]);
  if (!state || !active || !participation) {
    return null;
  }
  return (
    <>
      {!state.supported && (
        <div className="pointer-events-none absolute bottom-2 left-2 text-xs text-white">
          当前视口暂不支持共享光标
        </div>
      )}
      {state.colorRegistry && (
        <RemoteCursorOverlay
          selfParticipantId={participation.identity.participant_id}
          cursors={state.cursors}
          colorRegistry={state.colorRegistry}
          viewportSize={state.viewportSize}
        />
      )}
    </>
  );
}

function CornerstoneOverlays(props: withAppTypes) {
  const { viewportId, element, scrollbarHeight, servicesManager } = props;
  const { cornerstoneViewportService } = servicesManager.services;
  const [imageSliceData, setImageSliceData] = useState({
    imageIndex: 0,
    numberOfSlices: 0,
  });
  const [viewportData, setViewportData] = useState(null);

  useEffect(() => {
    const { unsubscribe } = cornerstoneViewportService.subscribe(
      cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
      props => {
        if (props.viewportId !== viewportId) {
          return;
        }

        setViewportData(props.viewportData);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [viewportId]);

  if (!element) {
    return null;
  }

  if (viewportData) {
    const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

    if (viewportInfo?.viewportOptions?.customViewportProps?.hideOverlays) {
      return null;
    }
  }

  return (
    <div className="noselect">
      <ViewportImageScrollbar
        viewportId={viewportId}
        viewportData={viewportData}
        element={element}
        imageSliceData={imageSliceData}
        setImageSliceData={setImageSliceData}
        scrollbarHeight={scrollbarHeight}
        servicesManager={servicesManager}
      />

      <CustomizableViewportOverlay
        imageSliceData={imageSliceData}
        viewportData={viewportData}
        viewportId={viewportId}
        servicesManager={servicesManager}
        element={element}
      />

      <ViewportImageSliceLoadingIndicator
        viewportData={viewportData}
        element={element}
      />

      <ViewportOrientationMarkers
        imageSliceData={imageSliceData}
        element={element}
        viewportData={viewportData}
        servicesManager={servicesManager}
        viewportId={viewportId}
      />
      <LocalSharingCursors
        element={element as HTMLElement}
        viewportId={viewportId as string}
        servicesManager={servicesManager}
      />
    </div>
  );
}

export default CornerstoneOverlays;
