/**
 * Stores Index - Exportaciones centralizadas
 *
 * Agrupa todos los stores de la aplicación:
 * - UI: panel activo, workbar, notificaciones
 * - Workspace: proyecto, provider, modelo, prompt
 * - Chat: mensajes, conversación
 * - Attachments: archivos adjuntos
 * - Persistence: guardar/cargar estado
 */

// UI Store
export {
  activePanel,
  workBarExpanded,
  notifications,
  notificationCount,
  isPanelOpen,
  openPanel,
  closePanel,
  toggleWorkBar,
  expandWorkBar,
  collapseWorkBar,
  addNotification,
  removeNotification,
  clearNotifications,
  notifySuccess,
  notifyError,
  notifyWarning,
  notifyInfo
} from './ui';

// Workspace Store
export {
  WORKSPACES,
  activeProject,
  activeProvider,
  activeModel,
  activePrompt,
  credentialStatus,
  activeWorkspace,
  workspaceConfig,
  hasProject,
  hasProvider,
  hasValidCredentials,
  selectProject,
  clearProject,
  selectProvider,
  clearProvider,
  selectPrompt,
  clearPrompt,
  initWorkspaceSubscriptions,
  getActiveProject,
  getActiveProvider,
  getActiveModel,
  getPersistedWorkspace
} from './workspace';

// Chat Store
export {
  messages,
  conversationId,
  isStreaming,
  streamingMessageId,
  messageCount,
  hasConversation,
  lastMessage,
  userMessages,
  assistantMessages,
  sendMessage,
  addMessage,
  endStreaming,
  loadConversation,
  newConversation,
  clearMessages,
  clearConversation,
  initChatSubscriptions,
  getMessages,
  getConversationId,
  getIsStreaming
} from './chat';

// Attachments Store
export {
  attachments,
  attachmentCount,
  hasAttachments,
  canAddMore,
  totalSize,
  addAttachment,
  addAttachments,
  removeAttachment,
  removeAttachmentByPath,
  clearAttachments,
  getFileType,
  getAttachmentIcon,
  formatFileSize,
  getAttachments,
  getAttachmentCount
} from './attachments';

// Persistence Store
export {
  loadState,
  saveState,
  getState,
  clearState,
  saveWorkspace,
  saveUI,
  savePanelSize,
  getPanelSize,
  saveConversation,
  saveLastConversationForProject,
  getLastConversationForProject,
  saveDefaultProvider,
  getDefaultProvider
} from './persistence';

// Theme Store
export {
  themeMode,
  effectiveTheme,
  themeColors,
  setTheme,
  toggleTheme,
  applyTheme
} from './theme';
export type { ThemeMode, ThemeColors } from './theme';

// Credentials Store (MQTT-based)
export {
  credentialsStore,
  initCredentialsSubscriptions,
  requestState as requestCredentialsState,
  createCredential,
  updateCredential,
  deleteCredential,
  testCredential,
  selectCredential,
  setActiveTab as setCredentialsTab,
  clearTestResult,
  allCredentials,
  globalCredentials,
  projectCredentials,
  clientCredentials,
  customCredentials,
  selectedCredential,
  providers as credentialProviders,
  levels as credentialLevels,
  isLoading as credentialsLoading,
  hasError as credentialsHasError,
  credentialError,
  credentialCount,
  activeTab as credentialsActiveTab,
  testResult as credentialsTestResult
} from './credentials';
export type { Credential, ProviderOption, LevelOption, CredentialsState } from './credentials';

// Projects Store (MQTT-based)
export {
  projectsStore,
  initProjectsSubscriptions,
  requestProjectsState,
  createProject as createProjectMqtt,
  updateProject as updateProjectMqtt,
  deleteProject as deleteProjectMqtt,
  activateProject as activateProjectMqtt,
  projectsList,
  activeProjectId as activeProjectIdMqtt,
  activeProjectData,
  projectsLoading,
  projectsError,
  projectsCount,
  hasProjects
} from './projects';
export type { Project, ProjectsState } from './projects';

// Conversations Store (MQTT-based)
export {
  conversationsStore,
  loadConversations,
  createConversation,
  selectConversation,
  startNewConversation,
  restoreLastConversation,
  switchProject,
  clearConversations,
  conversationsList,
  conversationsProjectId,
  conversationsLoading,
  conversationsError,
  conversationsCount,
  hasConversations,
  activeConversationData
} from './conversations';
export type { Conversation, ConversationsState } from './conversations';

// Initialization
export {
  initializeApp,
  handleProjectChange,
  isInitialized,
  isInitializing,
  resetInit
} from './init';
