/** Local DICOM demo: image data stays in the browser, with no PACS dependency. */
window.config = {
  name: 'config/phase-one-e2e.js',
  phaseOneBusiness: { enabled: true },
  routerBasename: '/',
  extensions: [],
  modes: [],
  customizationService: {},
  showStudyList: true,
  maxNumberOfWebWorkers: 2,
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: false,
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
