import React from 'react';

import { Toolbox } from '@ohif/extension-default';
import PanelSegmentation from './panels/PanelSegmentation';
import ActiveViewportWindowLevel from './components/ActiveViewportWindowLevel';
import PanelMeasurement from './panels/PanelMeasurement';
import MaskEditingTools from './panels/MaskEditingTools';

const getPanelModule = ({ commandsManager, servicesManager, extensionManager }: withAppTypes) => {
  const wrappedPanelSegmentation = ({ configuration }) => {
    return (
      <PanelSegmentation
        commandsManager={commandsManager}
        servicesManager={servicesManager}
        extensionManager={extensionManager}
        configuration={{
          ...configuration,
        }}
      />
    );
  };

  const wrappedPanelSegmentationNoHeader = ({ configuration }) => {
    return (
      <PanelSegmentation
        commandsManager={commandsManager}
        servicesManager={servicesManager}
        extensionManager={extensionManager}
        configuration={{
          ...configuration,
        }}
      />
    );
  };

  const wrappedPanelSegmentationWithTools = ({ configuration }) => {
    const { toolbarService } = servicesManager.services;

    return (
      <div className="mask-workbench-panel">
        <MaskEditingTools />
        <details className="mask-advanced-tools">
          <summary>高级工具 · OHIF</summary>
          <Toolbox
            buttonSectionId={toolbarService.sections.segmentationToolbox}
            title="Segmentation Tools"
          />
        </details>
      </div>
    );
  };

  return [
    {
      name: 'panelMaskManager',
      iconName: 'tab-segmentation',
      iconLabel: 'Masks',
      label: 'Mask 列表',
      component: () => (
        <div className="mask-manager">
          <div className="mask-manager-intro">
            <strong>项目 · Masks</strong>
            <p>在这里选择、命名、显隐或锁定 Mask，再到右侧进行分割编辑。</p>
          </div>
          <PanelSegmentation
            title="Masks · 蒙版列表"
            allViewports
          />
        </div>
      ),
    },
    {
      name: 'activeViewportWindowLevel',
      component: () => {
        return <ActiveViewportWindowLevel servicesManager={servicesManager} />;
      },
    },
    {
      name: 'panelMeasurement',
      iconName: 'tab-linear',
      iconLabel: 'Measure',
      label: 'Measurement',
      component: PanelMeasurement,
    },
    {
      name: 'panelSegmentation',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      label: 'Segmentation',
      component: wrappedPanelSegmentation,
    },
    {
      name: 'panelSegmentationNoHeader',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      label: 'Segmentation',
      component: wrappedPanelSegmentationNoHeader,
    },
    {
      name: 'panelSegmentationWithTools',
      iconName: 'tab-segmentation',
      iconLabel: '分割',
      label: '分割工作台',
      component: wrappedPanelSegmentationWithTools,
    },
  ];
};

export default getPanelModule;
