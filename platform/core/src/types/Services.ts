import type { BusinessServices } from './BusinessContracts';
import {
  HangingProtocolService,
  CustomizationService,
  MeasurementService,
  ViewportGridService,
  ToolbarService,
  DisplaySetService,
  UINotificationService,
  UIModalService,
  WorkflowStepsService,
  CineService,
  UserAuthenticationService,
  PanelService,
  UIDialogService,
  UIViewportDialogService,
  MultiMonitorService,
} from '../services';

/**
 * The interface for the services object
 */

interface Services {
  businessServices?: BusinessServices;
  hangingProtocolService?: HangingProtocolService;
  customizationService?: CustomizationService;
  measurementService?: MeasurementService;
  displaySetService?: DisplaySetService;
  toolbarService?: ToolbarService;
  viewportGridService?: ViewportGridService;
  uiModalService?: UIModalService;
  uiNotificationService?: UINotificationService;
  workflowStepsService: WorkflowStepsService;
  cineService?: CineService;
  userAuthenticationService?: UserAuthenticationService;
  uiDialogService?: UIDialogService;
  uiViewportDialogService?: UIViewportDialogService;
  panelService?: PanelService;
  multiMonitorService?: MultiMonitorService;
}

export default Services;
