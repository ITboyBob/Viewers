import { renderConfirmedOverlay } from './ReadonlyPreviewRenderer';
const file = { file_id: 'f', study_uid: '1', series_uid: '2', sop_uid: '3' } as any;
const dataset = {
  ImagePositionPatient: [0, 0, 0],
  ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
  PixelSpacing: [1, 1],
  FrameOfReferenceUID: 'frame',
};
function context() {
  return {
    getImageData: jest.fn(() => ({
      data: new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]),
    })),
    putImageData: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    closePath: jest.fn(),
    stroke: jest.fn(),
    fillText: jest.fn(),
    ellipse: jest.fn(),
    arc: jest.fn(),
    setLineDash: jest.fn(),
  } as any;
}
test('只叠加固定首帧SEG，忽略临时隐藏且使用已存颜色', () => {
  const ctx = context();
  renderConfirmedOverlay(
    ctx,
    { columns: 2, rows: 1 },
    dataset,
    file,
    [file],
    [
      {
        taskId: 't',
        annotations: [],
        measurements: [],
        segmentations: [
          {
            frames: [
              {
                referenceId: 'urn:colla:image:1/2/3',
                rows: 1,
                columns: 2,
                pixels: new Uint8Array([1, 0]),
              },
            ],
            colors: { 1: [255, 0, 0, 255] },
            visible: { 1: false },
          },
        ],
      },
    ]
  );
  const pixels = ctx.putImageData.mock.calls[0][0].data;
  expect(pixels[0]).toBeGreaterThan(100);
  expect(pixels[1]).toBeLessThan(100);
  expect([...pixels.slice(4)]).toEqual([100, 100, 100, 255]);
});
test('其他切片或后续帧不能叠加到固定封面', () => {
  const ctx = context(),
    other = { ...file, sop_uid: '4' };
  renderConfirmedOverlay(
    ctx,
    { columns: 2, rows: 1 },
    dataset,
    file,
    [file, other],
    [
      {
        annotations: [
          {
            metadata: { referencedImageId: 'urn:colla:image:1/2/3&frame=2', toolName: 'Length' },
            data: {
              handles: {
                points: [
                  [0, 0, 0],
                  [1, 0, 0],
                ],
              },
            },
          },
        ],
        segmentations: [],
        measurements: [],
      },
    ]
  );
  expect(ctx.stroke).not.toHaveBeenCalled();
});
test('已确认SR与RTSTRUCT按世界坐标落到原图，未知工具不能伪装空成果', () => {
  const ctx = context();
  const annotation = {
    annotationUID: 'a',
    metadata: { referencedImageId: 'urn:colla:image:1/2/3', toolName: 'Length' },
    data: {
      handles: {
        points: [
          [0, 0, 0],
          [1, 0, 0],
        ],
      },
    },
  };
  renderConfirmedOverlay(
    ctx,
    { columns: 2, rows: 1 },
    dataset,
    file,
    [file],
    [
      {
        annotations: [annotation],
        measurements: [{ uid: 'a', displayText: { primary: ['1 mm'] } }],
        segmentations: [],
      },
    ]
  );
  expect(ctx.lineTo).toHaveBeenCalledWith(1, 0);
  expect(ctx.fillText).toHaveBeenCalled();
  annotation.metadata.toolName = 'Unknown';
  expect(() =>
    renderConfirmedOverlay(
      ctx,
      { columns: 2, rows: 1 },
      dataset,
      file,
      [file],
      [{ annotations: [annotation], segmentations: [], measurements: [] }]
    )
  ).toThrow();
});

test.each([
  'CircleROI',
  'EllipticalROI',
  'RectangleROI',
  'Bidirectional',
  'SegmentBidirectional',
  'CobbAngle',
  'ArrowAnnotate',
  'Probe',
  'SCOORD3DPoint',
  'Length',
  'Angle',
  'UltrasoundDirectionalTool',
  'UltrasoundPleuraBLineTool',
  'PlanarFreehandROI',
  'SplineROI',
  'LivewireContour',
  'PlanarFreehandContourSegmentation',
])('当前支持的%s图形只用局部画布', toolName => {
  const ctx = context();
  const item: any = {
    annotationUID: 'a',
    metadata: { referencedImageId: 'urn:colla:image:1/2/3', toolName },
    data: {
      handles: {
        points: [
          [0, 0, 0],
          [0, 2, 0],
          [2, 0, 0],
          [2, 2, 0],
        ],
      },
      text: '已确认',
    },
  };
  if (/Contour|Freehand|Spline|Livewire/.test(toolName))
    item.data.contour = {
      polyline: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      closed: true,
    };
  renderConfirmedOverlay(
    ctx,
    { columns: 32, rows: 32 },
    dataset,
    file,
    [file],
    [
      {
        annotations: [item],
        measurements: [],
        segmentations: [],
        presentation: { a: { color: '#f00', lineWidth: 2 } },
      },
    ]
  );
  expect(ctx.stroke).toHaveBeenCalled();
  expect(ctx.fillText).toHaveBeenCalled();
  expect(ctx.strokeStyle).toBe('#f00');
});
test('RTSTRUCT只绘制同坐标系与同切片轮廓，采用确认颜色', () => {
  const ctx = context();
  renderConfirmedOverlay(
    ctx,
    { columns: 32, rows: 32 },
    dataset,
    file,
    [file],
    [
      {
        annotations: [],
        measurements: [],
        segmentations: [
          {
            frames: [],
            colors: { 1: [0, 0, 255, 255] },
            contour: {},
            geometries: [
              {
                frameOfReferenceUID: 'other',
                color: [255, 0, 0, 255],
                data: [
                  {
                    points: [
                      [0, 0, 0],
                      [1, 0, 0],
                    ],
                  },
                ],
              },
              {
                frameOfReferenceUID: 'frame',
                segmentIndex: 1,
                color: [255, 0, 0, 255],
                data: [
                  {
                    points: [
                      [0, 0, 5],
                      [1, 0, 5],
                    ],
                  },
                  {
                    points: [
                      [0, 0, 0],
                      [1, 0, 0],
                    ],
                    type: 'OPEN_PLANAR',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]
  );
  expect(ctx.stroke).toHaveBeenCalledTimes(1);
  expect(ctx.strokeStyle).toBe('rgb(0,0,255)');
  expect(ctx.closePath).not.toHaveBeenCalled();
});
test('拒绝不完整成果、异任务引用、尺寸和非法几何', () => {
  const render = (state: any, ds: any = dataset) =>
    renderConfirmedOverlay(context(), { columns: 2, rows: 1 }, ds, file, [file], [state]);
  expect(() => render({})).toThrow();
  expect(() => render({ annotations: [], measurements: [], segmentations: [{}] })).toThrow();
  expect(() =>
    render({ annotations: [], measurements: [], segmentations: [{ frames: [], contour: {} }] })
  ).toThrow();
  expect(() =>
    render({
      annotations: [],
      measurements: [],
      segmentations: [{ frames: [{ referenceId: 'other' }] }],
    })
  ).toThrow();
  expect(() =>
    render({
      annotations: [],
      measurements: [],
      segmentations: [
        { frames: [{ referenceId: 'urn:colla:image:1/2/3', rows: 1, columns: 1, pixels: [1] }] },
      ],
    })
  ).toThrow();
  const item: any = {
    metadata: { referencedImageId: 'urn:colla:image:1/2/3', toolName: 'Length' },
    data: {
      handles: {
        points: [
          [0, 0, 0],
          [1, 0, 0],
        ],
      },
    },
  };
  expect(() =>
    render(
      { annotations: [item], measurements: [], segmentations: [] },
      { ImageOrientationPatient: [1] }
    )
  ).toThrow();
  item.data = {};
  expect(() => render({ annotations: [item], measurements: [], segmentations: [] })).toThrow();
});
test('增强多帧首帧使用功能组几何，斜切平面外批注不投影伪装', () => {
  const ctx = context(),
    ds = {
      PerFrameFunctionalGroupsSequence: [
        {
          PlanePositionSequence: { ImagePositionPatient: [10, 20, 30] },
          PlaneOrientationSequence: { ImageOrientationPatient: [0, 1, 0, 1, 0, 0] },
          PixelMeasuresSequence: { PixelSpacing: [2, 3] },
        },
      ],
    };
  const item: any = {
    metadata: { referencedImageId: 'urn:colla:image:1/2/3&frame=1', toolName: 'Length' },
    data: {
      handles: {
        points: [
          [10, 20, 30],
          [12, 23, 30],
        ],
      },
    },
  };
  renderConfirmedOverlay(
    ctx,
    { columns: 32, rows: 32 },
    ds,
    file,
    [file],
    [{ annotations: [item], measurements: [], segmentations: [] }]
  );
  expect(ctx.lineTo).toHaveBeenCalledWith(1, 1);
  item.data.handles.points = [
    [10, 20, 35],
    [12, 23, 35],
  ];
  ctx.stroke.mockClear();
  renderConfirmedOverlay(
    ctx,
    { columns: 32, rows: 32 },
    ds,
    file,
    [file],
    [{ annotations: [item], measurements: [], segmentations: [] }]
  );
  expect(ctx.stroke).not.toHaveBeenCalled();
});

test('重叠重建相邻片轮廓不能借采集层厚进入固定片', () => {
  const ctx = context();
  renderConfirmedOverlay(
    ctx,
    { columns: 32, rows: 32 },
    { ...dataset, SliceThickness: 5, SpacingBetweenSlices: 1 },
    file,
    [file],
    [
      {
        annotations: [],
        measurements: [],
        segmentations: [
          {
            frames: [],
            colors: {},
            contour: {},
            geometries: [
              {
                frameOfReferenceUID: 'frame',
                color: [0, 255, 0, 255],
                data: [
                  {
                    points: [
                      [0, 0, 1],
                      [1, 0, 1],
                      [1, 1, 1],
                    ],
                    type: 'CLOSED_PLANAR',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]
  );
  expect(ctx.stroke).not.toHaveBeenCalled();
});
test('缺省几何的合法影像采用与工作台相同的单位平面', () => {
  const ctx = context();
  renderConfirmedOverlay(
    ctx,
    { columns: 32, rows: 32 },
    {},
    file,
    [file],
    [
      {
        annotations: [
          {
            metadata: { referencedImageId: 'urn:colla:image:1/2/3', toolName: 'Length' },
            data: {
              handles: {
                points: [
                  [0, 0, 0],
                  [1, 2, 0],
                ],
              },
            },
          },
        ],
        measurements: [],
        segmentations: [],
      },
    ]
  );
  expect(ctx.lineTo).toHaveBeenCalledWith(1, 2);
});
test('轮廓派生标注是权威表示，不叠画旧几何或覆盖确认分割颜色', () => {
  const ctx = context();
  const annotation: any = {
    annotationUID: 'a',
    metadata: {
      referencedImageId: 'urn:colla:image:1/2/3',
      toolName: 'PlanarFreehandContourSegmentationTool',
    },
    data: {
      segmentation: { segmentationId: 'seg', segmentIndex: 1 },
      contour: {
        polyline: [
          [0, 0, 0],
          [2, 0, 0],
          [2, 2, 0],
        ],
        closed: true,
      },
    },
  };
  renderConfirmedOverlay(ctx, { columns: 32, rows: 32 }, dataset, file, [file], [
    {
      annotations: [annotation],
      measurements: [],
      presentation: { a: { color: '#ff0000', lineWidth: 1 } },
      segmentations: [
        {
          segmentationId: 'seg',
          frames: [],
          colors: { 1: [0, 0, 255, 255] },
          contour: { annotationUIDsMap: new Map([[1, new Set(['a'])]]) },
          geometries: [
            {
              frameOfReferenceUID: 'frame',
              segmentIndex: 1,
              color: [0, 255, 0, 255],
              data: [
                {
                  points: [
                    [0, 0, 0],
                    [1, 0, 0],
                    [1, 1, 0],
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ] as any);
  expect(ctx.stroke).toHaveBeenCalledTimes(1);
  expect(ctx.strokeStyle).toBe('rgb(0,0,255)');
  expect(ctx.lineTo).toHaveBeenCalledWith(2, 0);
});
test('非等距像素的物理圆投影为正确像素椭圆', () => {
  const ctx = context();
  renderConfirmedOverlay(
    ctx,
    { columns: 64, rows: 64 },
    { ...dataset, PixelSpacing: [2, 1] },
    file,
    [file],
    [
      {
        annotations: [
          {
            metadata: { referencedImageId: 'urn:colla:image:1/2/3', toolName: 'CircleROI' },
            data: {
              handles: {
                points: [
                  [20, 20, 0],
                  [30, 20, 0],
                ],
              },
            },
          },
        ],
        measurements: [],
        segmentations: [],
      },
    ]
  );
  expect(ctx.ellipse).toHaveBeenCalledWith(20, 10, 10, 5, 0, 0, 2 * Math.PI);
});
