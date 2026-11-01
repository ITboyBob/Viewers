/** Local DICOM demo: image data stays in the browser, with no PACS dependency. */
window.config = {
  name: 'config/mask-demo.js',
  phaseOneBusiness: { enabled: true },
  routerBasename: '/',
  extensions: [],
  modes: [],
  customizationService: {},
  showStudyList: true,
  maxNumberOfWebWorkers: 2,
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  groupEnabledModesFirst: true,
  defaultDataSourceName: 'dicomlocal',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomlocal',
      sourceName: 'dicomlocal',
      configuration: { friendlyName: 'Local Mask Demo' },
    },
  ],
};
