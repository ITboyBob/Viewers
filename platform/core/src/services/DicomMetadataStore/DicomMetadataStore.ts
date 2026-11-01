import dcmjs from 'dcmjs';
import { cloneDeep } from 'lodash';

import pubSubServiceInterface from '../_shared/pubSubServiceInterface';
import createStudyMetadata from './createStudyMetadata';

const EVENTS = {
  STUDY_ADDED: 'event::dicomMetadataStore:studyAdded',
  INSTANCES_ADDED: 'event::dicomMetadataStore:instancesAdded',
  SERIES_ADDED: 'event::dicomMetadataStore:seriesAdded',
  SERIES_UPDATED: 'event::dicomMetadataStore:seriesUpdated',
};

/**
 * @example
 * studies: [
 *   {
 *     StudyInstanceUID: string,
 *     isLoaded: boolean,
 *     series: [
 *       {
 *         Modality: string,
 *         SeriesInstanceUID: string,
 *         SeriesNumber: number,
 *         SeriesDescription: string,
 *         instances: [
 *           {
 *             // naturalized instance metadata
 *             SOPInstanceUID: string,
 *             SOPClassUID: string,
 *             Rows: number,
 *             Columns: number,
 *             PatientSex: string,
 *             Modality: string,
 *             InstanceNumber: string,
 *           },
 *           {
 *             // instance 2
 *           },
 *         ],
 *       },
 *       {
 *         // series 2
 *       },
 *     ],
 *   },
 * ],
 */
const _baseModel = { studies: [] };
let _activeScope: { model: typeof _baseModel } | undefined;
const _getModel = () => _activeScope?.model ?? _baseModel;

/** 先在独立模型构建成功子集，登记成功后方可激活；从不清空原生base。 */
function prepareLocalImportScope(scopeId: string, datasets: readonly Record<string, unknown>[]) {
  if (!scopeId || !Array.isArray(datasets) || datasets.length === 0) {
    throw new Error('本地导入作用域需要有效批次和成功影像');
  }
  const model: typeof _baseModel = { studies: [] };
  for (const dataset of datasets) {
    if (
      !dataset ||
      !['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID'].every(
        field => typeof dataset[field] === 'string' && dataset[field].length > 0
      )
    ) {
      throw new Error('本地导入元数据缺少有效UID');
    }
    let study = model.studies.find(item => item.StudyInstanceUID === dataset.StudyInstanceUID);
    if (!study) {
      study = createStudyMetadata(dataset.StudyInstanceUID);
      model.studies.push(study);
    }
    // 复用原模型的SOP首次项折叠；隔离嵌套metadata，作用域写入不影响输入或base。
    study.addInstanceToSeries(cloneDeep(dataset));
  }
  const scope = { model };
  let released = false;
  return {
    isActive: () => !released && _activeScope === scope,
    activate() {
      if (released || (_activeScope && _activeScope !== scope)) {
        throw new Error('本地导入作用域已释放或存在其他活跃批次');
      }
      _activeScope = scope;
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      if (_activeScope === scope) {
        _activeScope = undefined;
      }
    },
  };
}

function _getStudyInstanceUIDs() {
  return _getModel().studies.map(aStudy => aStudy.StudyInstanceUID);
}

/**
 * Gets a study (a collection of series) using it's StudyInstanceUID
 * @param {*} StudyInstanceUID - Unique Identifier for the study
 * @returns {*} A study object
 */
function _getStudy(StudyInstanceUID) {
  return _getModel().studies.find(aStudy => aStudy.StudyInstanceUID === StudyInstanceUID);
}

/**
 * Gets a series (a collection of images) using both
 * the Study and Series InstanceUID's
 * @param {*} StudyInstanceUID - Unique Identifier for the study
 * @param {*} SeriesInstanceUID - Unique Identifier for the series
 * @returns {*} A series object
 */
function _getSeries(StudyInstanceUID, SeriesInstanceUID) {
  if (!StudyInstanceUID) {
    const series = _getModel()
      .studies.map(study => study.series)
      .flat();
    return series.find(aSeries => aSeries.SeriesInstanceUID === SeriesInstanceUID);
  }

  const study = _getStudy(StudyInstanceUID);

  if (!study) {
    return;
  }

  return study.series.find(aSeries => aSeries.SeriesInstanceUID === SeriesInstanceUID);
}

/**
 * Gets an instance (a single image or object)
 * @param {*} StudyInstanceUID - Unique Identifier for the study
 * @param {*} SeriesInstanceUID - Unique Identifier for the series
 * @param {*} SOPInstanceUID Unique Identifier for a specific instance
 * @returns an instance object
 */
function _getInstance(StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID) {
  const series = _getSeries(StudyInstanceUID, SeriesInstanceUID);

  if (!series) {
    return;
  }

  return series.getInstance(SOPInstanceUID);
}

function _getInstanceByImageId(imageId) {
  for (const study of _getModel().studies) {
    for (const series of study.series) {
      for (const instance of series.instances) {
        if (instance.imageId === imageId) {
          return instance;
        }
      }
    }
  }
}

/**
 * Update the metadata of a specific series
 * @param {*} StudyInstanceUID
 * @param {*} SeriesInstanceUID
 * @param {*} metadata metadata inform of key value pairs
 * @returns
 */
function _updateMetadataForSeries(StudyInstanceUID, SeriesInstanceUID, metadata) {
  const study = _getStudy(StudyInstanceUID);

  if (!study) {
    return;
  }

  const series = study.series.find(aSeries => aSeries.SeriesInstanceUID === SeriesInstanceUID);

  const { instances } = series;
  // update all instances metadata for this series with the new metadata
  instances.forEach(instance => {
    Object.keys(metadata).forEach(key => {
      // if metadata[key] is an object, we need to merge it with the existing
      // metadata of the instance
      if (typeof metadata[key] === 'object') {
        instance[key] = { ...instance[key], ...metadata[key] };
      }
      // otherwise, we just replace the existing metadata with the new one
      else {
        instance[key] = metadata[key];
      }
    });
  });

  // broadcast the series updated event
  this._broadcastEvent(EVENTS.SERIES_UPDATED, {
    SeriesInstanceUID,
    StudyInstanceUID,
    madeInClient: true,
  });
}

const BaseImplementation = {
  EVENTS,
  prepareLocalImportScope,
  listeners: {},
  addInstance(dicomJSONDatasetOrP10ArrayBuffer) {
    let dicomJSONDataset;

    // If Arraybuffer, parse to DICOMJSON before naturalizing.
    if (dicomJSONDatasetOrP10ArrayBuffer instanceof ArrayBuffer) {
      const dicomData = dcmjs.data.DicomMessage.readFile(dicomJSONDatasetOrP10ArrayBuffer);

      dicomJSONDataset = dicomData.dict;
    } else {
      dicomJSONDataset = dicomJSONDatasetOrP10ArrayBuffer;
    }

    let naturalizedDataset;

    if (dicomJSONDataset['SeriesInstanceUID'] === undefined) {
      naturalizedDataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomJSONDataset);
    } else {
      naturalizedDataset = dicomJSONDataset;
    }

    const { StudyInstanceUID } = naturalizedDataset;

    let study = _getModel().studies.find(study => study.StudyInstanceUID === StudyInstanceUID);

    if (!study) {
      _getModel().studies.push(createStudyMetadata(StudyInstanceUID));
      study = _getModel().studies[_getModel().studies.length - 1];
    }

    study.addInstanceToSeries(naturalizedDataset);
  },
  addInstances(instances, madeInClient = false) {
    const { StudyInstanceUID, SeriesInstanceUID } = instances[0];

    let study = _getModel().studies.find(study => study.StudyInstanceUID === StudyInstanceUID);

    if (!study) {
      _getModel().studies.push(createStudyMetadata(StudyInstanceUID));

      study = _getModel().studies[_getModel().studies.length - 1];
    }

    study.addInstancesToSeries(instances);

    // Broadcast an event even if we used cached data.
    // This is because the mode needs to listen to instances that are added to build up its active displaySets.
    // It will see there are cached displaySets and end early if this Series has already been fired in this
    // Mode session for some reason.
    this._broadcastEvent(EVENTS.INSTANCES_ADDED, {
      StudyInstanceUID,
      SeriesInstanceUID,
      madeInClient,
    });
  },
  updateSeriesMetadata(seriesMetadata) {
    const { StudyInstanceUID, SeriesInstanceUID } = seriesMetadata;
    const series = _getSeries(StudyInstanceUID, SeriesInstanceUID);
    if (!series) {
      return;
    }

    const study = _getStudy(StudyInstanceUID);
    if (study) {
      study.setSeriesMetadata(SeriesInstanceUID, seriesMetadata);
    }
  },
  addSeriesMetadata(seriesSummaryMetadata, madeInClient = false) {
    if (!seriesSummaryMetadata || !seriesSummaryMetadata.length || !seriesSummaryMetadata[0]) {
      return;
    }

    const { StudyInstanceUID } = seriesSummaryMetadata[0];
    let study = _getStudy(StudyInstanceUID);
    if (!study) {
      study = createStudyMetadata(StudyInstanceUID);
      // Will typically be undefined with a compliant DICOMweb server, reset later
      study.StudyDescription = seriesSummaryMetadata[0].StudyDescription;
      seriesSummaryMetadata.forEach(item => {
        if (study.ModalitiesInStudy.indexOf(item.Modality) === -1) {
          study.ModalitiesInStudy.push(item.Modality);
        }
      });
      study.NumberOfStudyRelatedSeries = seriesSummaryMetadata.length;
      _getModel().studies.push(study);
    }

    seriesSummaryMetadata.forEach(series => {
      const { SeriesInstanceUID } = series;

      study.setSeriesMetadata(SeriesInstanceUID, series);
    });

    this._broadcastEvent(EVENTS.SERIES_ADDED, {
      StudyInstanceUID,
      seriesSummaryMetadata,
      madeInClient,
    });
  },
  addStudy(study) {
    const { StudyInstanceUID } = study;

    const existingStudy = _getModel().studies.find(
      study => study.StudyInstanceUID === StudyInstanceUID
    );

    if (!existingStudy) {
      const newStudy = createStudyMetadata(StudyInstanceUID);

      newStudy.PatientID = study.PatientID;
      newStudy.PatientName = study.PatientName;
      newStudy.StudyDate = study.StudyDate;
      newStudy.ModalitiesInStudy = study.ModalitiesInStudy;
      newStudy.StudyDescription = study.StudyDescription;
      newStudy.AccessionNumber = study.AccessionNumber;
      newStudy.NumInstances = study.NumInstances; // todo: Correct naming?

      _getModel().studies.push(newStudy);
    }
  },
  getStudyInstanceUIDs: _getStudyInstanceUIDs,
  getStudy: _getStudy,
  getSeries: _getSeries,
  getInstance: _getInstance,
  getInstanceByImageId: _getInstanceByImageId,
  updateMetadataForSeries: _updateMetadataForSeries,
};
const DicomMetadataStore = Object.assign(
  // get study

  // iterate over all series

  {},
  BaseImplementation,
  pubSubServiceInterface
);

export { DicomMetadataStore };
export default DicomMetadataStore;
