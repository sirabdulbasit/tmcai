// ═════════════════════════════════════════════════════════════════════════════
// IWhatsAppProvider — Provider interface for WhatsApp integration
//
// Both WebjsProvider (free/dev) and MetaProvider (production) implement this.
// Switching provider = one config change in admin panel. Zero code changes.
// ═════════════════════════════════════════════════════════════════════════════

export interface SendMessageParams {
  clientNumber: string;
  to: string;
  message: string;
  messageType: 'text' | 'template';
  templateName?: string;
  templateParams?: string[];
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /** provider_receipt = provider returned an immutable message id;
   * transport_accepted = send resolved without a receipt, so do not retry. */
  confirmation?: 'provider_receipt' | 'transport_accepted';
  warning?: string;
}

export interface ConnectionStatus {
  status: 'disconnected' | 'connecting' | 'connected' | 'init_timeout' | 'error';
  connectedNumber?: string;
  error?: string;
  init?: {
    startedAt: number | null;
    deadlineAt: number | null;
    retryAt: number | null;
    consecutiveTimeouts: number;
    requiresRepair: boolean;
  };
}

export interface TestResult {
  success: boolean;
  connectedNumber?: string;
  error?: string;
}

export interface IWhatsAppProvider {
  /** Initialize the provider for a tenant (connect, start session, etc.) */
  initialize(clientNumber: string): Promise<void>;

  /** Get QR code for scanning (webjs only; Meta returns null) */
  getQRCode(clientNumber: string): Promise<string | null>;

  /** Test if the connection is alive and working */
  testConnection(clientNumber: string): Promise<TestResult>;

  /** Send a message to a phone number */
  sendMessage(params: SendMessageParams): Promise<SendResult>;

  /** Disconnect and clean up resources */
  disconnect(clientNumber: string): Promise<void>;

  /** Get current connection status */
  getStatus(clientNumber: string): Promise<ConnectionStatus>;
}
