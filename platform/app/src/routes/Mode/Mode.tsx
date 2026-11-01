import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, useLocation } from 'react-router';
import PropTypes from 'prop-types';
import { utils } from '@ohif/core';
import type { HotkeysManager, SharedViewContext } from '@ohif/core';
import { createModeProjectLifecycle } from '../../business/ProjectRuntimeService';
import { ImageViewerProvider, DragAndDropProvider } from '@ohif/ui-next';
import { useSearchParams } from '../../hooks';
import { useAppConfig } from '@state';
import ViewportGrid from '@components/ViewportGrid';
import Compose from './Compose';
import loadModules from '../../pluginImports';
import { defaultRouteInit } from './defaultRouteInit';
import { updateAuthServiceAndCleanUrl } from './updateAuthServiceAndCleanUrl';

const { getSplitParam } = utils;

type ModeLayout = {
  id: string;
  props: Record<string, unknown> & { leftPanels?: string[]; rightPanels?: string[] };
};
export type ModeDefinition = {
  routeName: string;
  extensions: Record<string, unknown>;
  sopClassHandlers: string[];
  hangingProtocol?: string | string[];
  routes: Array<{
    layoutTemplate(context: Record<string, unknown>): ModeLayout | Promise<ModeLayout>;
    init?(
      context: Record<string, unknown>,
      protocol: string | string[],
      stage: number
    ): unknown | Promise<unknown>;
  }>;
  onModeInit?(context: Record<string, unknown>): void;
  onModeEnter?(context: Record<string, unknown>): void;
  onModeExit?(context: Record<string, unknown>): void;
  onSetupRouteComplete?(context: Record<string, unknown>): void;
};
export type ModeRouteProps = {
  mode: ModeDefinition;
  dataSourceName?: string;
  extensionManager: AppTypes.ExtensionManager;
  servicesManager: AppTypes.ServicesManager;
  commandsManager: AppTypes.CommandsManager;
  hotkeysManager: HotkeysManager;
  phaseOneMask?: boolean;
  sharedView?: SharedViewContext;
};

export default function ModeRoute({
  mode,
  dataSourceName,
  extensionManager,
  servicesManager,
  commandsManager,
  hotkeysManager,
  phaseOneMask = false,
  sharedView,
}: ModeRouteProps) {
  const [appConfig] = useAppConfig();
  const sharedGeneration = sharedView?.load_generation;
  const lifetime = useRef<ReturnType<typeof createModeProjectLifecycle> | null>(null);
  if (!lifetime.current) {
    lifetime.current =
      (sharedView
        ? servicesManager.services.businessServices?.localCollaboration?.sharedView?.getModeLifecycle()
        : phaseOneMask
          ? servicesManager.services.businessServices?.projectRuntime?.getModeLifecycle()
          : null) ?? createModeProjectLifecycle(null);
  }
  useEffect(() => () => lifetime.current.dispose(), []);

  // Parse route params/querystring
  const location = useLocation();

  // The react router DOM placeholder map (see https://reactrouter.com/en/main/hooks/use-params).
  const params = useParams();
  // The URL's query search parameters where the keys casing is maintained
  const incomingQuery = useSearchParams();
  const query = sharedView
    ? new URLSearchParams([
        ...sharedView.study_uids.map(uid => ['StudyInstanceUIDs', uid]),
        ['datasources', 'dicomlocal'],
      ])
    : incomingQuery;

  mode?.onModeInit?.({
    servicesManager,
    extensionManager,
    commandsManager,
    appConfig,
    query,
  });

  // The URL's query search parameters where the keys are all lower case.
  const incomingLowerCase = useSearchParams({ lowerCaseKeys: true });
  const lowerCaseSearchParams = sharedView
    ? new URLSearchParams([...query.entries()].map(([key, value]) => [key.toLowerCase(), value]))
    : incomingLowerCase;

  const [studyInstanceUIDs, setStudyInstanceUIDs] = useState(null);

  const [refresh, setRefresh] = useState(false);
  const [ExtensionDependenciesLoaded, setExtensionDependenciesLoaded] = useState(false);

  const layoutTemplateData = useRef<ModeLayout | null>(null);
  const locationRef = useRef(null);
  const isMounted = useRef(false);

  if (location !== locationRef.current) {
    layoutTemplateData.current = null;
    locationRef.current = location;
  }

  const {
    displaySetService,
    panelService,
    hangingProtocolService,
    userAuthenticationService,
    customizationService,
  } = servicesManager.services;

  const { extensions, sopClassHandlers, hangingProtocol } = mode;

  const runTimeHangingProtocolId = lowerCaseSearchParams.get('hangingprotocolid');
  const runTimeStageId = lowerCaseSearchParams.get('stageid');
  const token = lowerCaseSearchParams.get('token');

  if (token) {
    updateAuthServiceAndCleanUrl(token, location, userAuthenticationService);
  }

  // An undefined dataSourceName implies that the active data source that is already set in the ExtensionManager should be used.
  if (dataSourceName !== undefined) {
    extensionManager.setActiveDataSource(dataSourceName);
  }

  const dataSource = extensionManager.getActiveDataSourceOrNull();

  // Only handling one route per mode for now
  const route = mode.routes?.[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    const loadExtensions = async () => {
      const loadedExtensions = await loadModules(Object.keys(extensions));
      if (cancelled) {
        return;
      }
      for (const extension of loadedExtensions) {
        const { id: extensionId } = extension;
        if (extensionManager.getRegisteredExtensionIds().indexOf(extensionId) === -1) {
          await extensionManager.registerExtension(extension);
          if (cancelled) {
            return;
          }
        }
      }

      if (isMounted.current) {
        setExtensionDependenciesLoaded(true);
      }
    };

    loadExtensions();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Preventing state update for unmounted component
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ExtensionDependenciesLoaded) {
      return;
    }

    // Todo: this should not be here, data source should not care about params
    let cancelled = false;
    const initializeDataSource = async (params, query) => {
      await dataSource.initialize({
        params,
        query,
      });
      if (cancelled) {
        return;
      }
      setStudyInstanceUIDs(dataSource.getStudyInstanceUIDs({ params, query }));
    };

    initializeDataSource(params, query);
    return () => {
      cancelled = true;
      layoutTemplateData.current = null;
    };
  }, [location, ExtensionDependenciesLoaded]);

  useEffect(() => {
    if (!ExtensionDependenciesLoaded || !studyInstanceUIDs?.length) {
      return;
    }

    let cancelled = false;
    const retrieveLayoutData = async () => {
      const layoutData = await route.layoutTemplate({
        location,
        servicesManager,
        studyInstanceUIDs,
      });

      if (!cancelled && isMounted.current) {
        const { leftPanels = [], rightPanels = [], ...layoutProps } = layoutData.props;

        panelService.reset();
        panelService.addPanels(panelService.PanelPosition.Left, leftPanels, undefined);
        panelService.addPanels(panelService.PanelPosition.Right, rightPanels, undefined);

        // layoutProps contains all props but leftPanels and rightPanels
        layoutData.props = layoutProps;

        layoutTemplateData.current = layoutData;
        setRefresh(!refresh);
      }
    };
    if (Array.isArray(studyInstanceUIDs) && studyInstanceUIDs[0]) {
      retrieveLayoutData();
    }
    return () => {
      cancelled = true;
      layoutTemplateData.current = null;
    };
  }, [studyInstanceUIDs, ExtensionDependenciesLoaded]);

  useEffect(() => {
    if (!layoutTemplateData.current || !ExtensionDependenciesLoaded || !studyInstanceUIDs?.length) {
      return;
    }

    let exited = false;
    const unsubscriptions: Array<() => void> = [];
    const stop = (unsubscribe: () => void) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn('native unsubscribe failure');
      }
    };
    const track = (values: unknown) => {
      if (!Array.isArray(values)) {
        return;
      }
      values
        .map(value =>
          typeof value === 'function'
            ? value
            : value && typeof value.unsubscribe === 'function'
              ? () => value.unsubscribe()
              : null
        )
        .filter(value => typeof value === 'function')
        .forEach(unsubscribe => {
          if (exited) {
            stop(unsubscribe);
          } else {
            unsubscriptions.push(unsubscribe);
          }
        });
    };
    const setupRouteInit = async () => {
      if (phaseOneMask) {
        servicesManager.services.businessServices?.projectRuntime?.beginMode(
          servicesManager.services,
          dataSourceName
        );
      }
      // TODO: For some reason this is running before the Providers
      // are calling setServiceImplementation
      // TODO -> iterate through services.

      // Extension

      // Add SOPClassHandlers to a new SOPClassManager.
      displaySetService.init(extensionManager, sopClassHandlers);

      extensionManager.onModeEnter();

      // use the URL hangingProtocolId if it exists, otherwise use the one
      // defined in the mode configuration
      const hangingProtocolIdToUse = hangingProtocolService.getProtocolById(
        runTimeHangingProtocolId
      )
        ? runTimeHangingProtocolId
        : hangingProtocol;

      // Determine the index of the stageId if the hangingProtocolIdToUse is defined
      const stageIndex = Array.isArray(hangingProtocolIdToUse)
        ? -1
        : hangingProtocolService.getStageIndex(hangingProtocolIdToUse, {
            stageId: runTimeStageId || undefined,
          });
      // Ensure that the stage index is never negative
      // If stageIndex is negative (e.g., if stage wasn't found), use 0 as the default
      const stageIndexToUse = Math.max(0, stageIndex);

      // Sets the active hanging protocols - if hangingProtocol is undefined,
      // resets to default.  Done before the onModeEnter to allow the onModeEnter
      // to perform custom hanging protocol actions
      hangingProtocolService.setActiveProtocolIds(hangingProtocolIdToUse);

      mode?.onModeEnter({
        servicesManager,
        extensionManager,
        commandsManager,
        appConfig,
      });

      // Move hotkeys setup here, after onModeEnter
      const hotkeys = customizationService.getCustomization('ohif.hotkeyBindings');
      hotkeysManager.setDefaultHotKeys(
        hotkeys as unknown as Parameters<HotkeysManager['setDefaultHotKeys']>[0]
      );

      /**
       * The next line should get all the query parameters provided by the URL
       * - except the StudyInstanceUIDs - and create an object called filters
       * used to filtering the study as the user wants otherwise it will return
       * a empty object.
       *
       * Example:
       * const filters = {
       *   seriesInstanceUID: 1.2.276.0.7230010.3.1.3.1791068887.5412.1620253993.114611
       * }
       */
      const filters =
        Array.from(query.keys()).reduce((acc: Record<string, string[]>, val: string) => {
          const lowerVal = val.toLowerCase();
          // Not sure why the case matters here - it doesn't in the URL
          if (lowerVal === 'seriesinstanceuids' || lowerVal === 'seriesinstanceuid') {
            const seriesUIDs = getSplitParam(lowerVal, query);
            return {
              ...acc,
              seriesInstanceUID: seriesUIDs,
            };
          }
          return { ...acc, [val]: getSplitParam(lowerVal, query) };
        }, {}) ?? {};

      if (route.init) {
        const unsubs = await route.init(
          {
            servicesManager,
            extensionManager,
            hotkeysManager,
            studyInstanceUIDs,
            dataSource,
            filters,
          },
          hangingProtocolIdToUse,
          stageIndexToUse
        );
        track(unsubs);
      }
      if (exited) {
        return;
      }
      track(
        await defaultRouteInit(
          {
            servicesManager,
            studyInstanceUIDs,
            dataSource,
            filters,
            appConfig,
          },
          hangingProtocolIdToUse,
          stageIndexToUse
        )
      );
    };

    const cleanup = lifetime.current.setNativeExit(() => {
      exited = true;
      // 本期业务先失活由共享边界保证，随后保持原mode→hotkeys→退订→extension次序。
      try {
        mode?.onModeExit?.({ servicesManager, extensionManager, appConfig });
      } finally {
        try {
          hotkeysManager.destroy();
        } finally {
          try {
            unsubscriptions.splice(0).forEach(stop);
          } finally {
            extensionManager.onModeExit();
          }
        }
      }
    });
    setupRouteInit()
      .then(() => {
        if (!exited) {
          mode?.onSetupRouteComplete?.({ servicesManager, extensionManager, commandsManager });
          const shared = servicesManager.services.businessServices?.localCollaboration;
          if (sharedGeneration !== undefined) {
            shared?.sharedView?.markSetupComplete(sharedGeneration);
          }
        }
      })
      .catch(() => {
        if (!exited) {
          try {
            lifetime.current.dispose();
          } finally {
            console.warn('mode setup failure');
          }
        }
      });
    return cleanup;
  }, [
    mode,
    dataSourceName,
    location,
    ExtensionDependenciesLoaded,
    route,
    servicesManager,
    extensionManager,
    hotkeysManager,
    studyInstanceUIDs,
    refresh,
    phaseOneMask,
    sharedGeneration,
  ]);

  // 共享状态提示会更新Mode props；保持组件身份，避免ready/detached重建已加载视口。
  const ViewportGridWithDataSource = useMemo(
    () => props => ViewportGrid({ ...props, dataSource }),
    [dataSource]
  );
  const CombinedExtensionsContextProvider = useMemo(
    () =>
      ExtensionDependenciesLoaded
        ? createCombinedContextProvider(extensionManager, servicesManager, commandsManager)
        : undefined,
    [ExtensionDependenciesLoaded, extensionManager, servicesManager, commandsManager]
  );

  if (!studyInstanceUIDs || !layoutTemplateData.current || !ExtensionDependenciesLoaded) {
    return null;
  }

  const getLayoutComponent = props => {
    const layoutTemplateModuleEntry = extensionManager.getModuleEntry(
      layoutTemplateData.current.id
    );
    const LayoutComponent = (
      layoutTemplateModuleEntry as { component: React.ComponentType<Record<string, unknown>> }
    ).component;

    return <LayoutComponent {...props} />;
  };

  const LayoutComponent = getLayoutComponent({
    ...layoutTemplateData.current.props,
    ViewportGridComp: ViewportGridWithDataSource,
  });

  return (
    <ImageViewerProvider StudyInstanceUIDs={studyInstanceUIDs}>
      {CombinedExtensionsContextProvider ? (
        <CombinedExtensionsContextProvider>
          <DragAndDropProvider>{LayoutComponent}</DragAndDropProvider>
        </CombinedExtensionsContextProvider>
      ) : (
        <DragAndDropProvider>{LayoutComponent}</DragAndDropProvider>
      )}
    </ImageViewerProvider>
  );
}

/**
 * Creates a combined context provider using the context modules from the extension manager.
 * @param {object} extensionManager - The extension manager instance.
 * @param {object} servicesManager - The services manager instance.
 * @param {object} commandsManager - The commands manager instance.
 * @returns {React.Component} - A React component that provides combined contexts to its children.
 */
function createCombinedContextProvider(extensionManager, servicesManager, commandsManager) {
  const extensionsContextModules = extensionManager.getModulesByType(
    extensionManager.constructor.MODULE_TYPES.CONTEXT
  );

  if (!extensionsContextModules?.length) {
    return;
  }

  const contextModuleProviders = extensionsContextModules.flatMap(({ module }) => {
    return module.map(aContextModule => {
      return aContextModule.provider;
    });
  });

  return ({ children }) => {
    return Compose({ components: contextModuleProviders, children });
  };
}

ModeRoute.propTypes = {
  mode: PropTypes.object.isRequired,
  dataSourceName: PropTypes.string,
  extensionManager: PropTypes.object,
  servicesManager: PropTypes.object,
  hotkeysManager: PropTypes.object,
  commandsManager: PropTypes.object,
};
