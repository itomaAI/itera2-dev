/**
 * src/ipc/Message.ts
 * Itera OS v2: IPC Message Definitions
 */

import { generateId } from '../utils/id';

export const PROTOCOL_VERSION = 'itera:ipc:v2';

export interface IpcMessageData {
  protocol: string;
  type: 'req' | 'res' | 'event';
  id: string;
  source: string;
  target: string;
  action: string;
  payload: any;
  error: string | null;
  /** 断った理由の短い名前（VfsError.code など）。文だけでは機械が見分けられないので添える。無ければ省く（T-0715） */
  errorCode?: string;
}

export class IpcMessage {
  static createRequest(source: string, target: string, action: string, payload: any = {}): IpcMessageData {
    return {
      protocol: PROTOCOL_VERSION,
      type: 'req',
      id: generateId(),
      source,
      target,
      action,
      payload,
      error: null,
    };
  }

  static createResponse(
    reqMessage: IpcMessageData,
    result: any,
    error: string | null = null,
    errorCode: string | null = null,
  ): IpcMessageData {
    const res: IpcMessageData = {
      protocol: PROTOCOL_VERSION,
      type: 'res',
      id: reqMessage.id,
      source: reqMessage.target, // 返信元
      target: reqMessage.source, // 返信先
      action: reqMessage.action,
      payload: result,
      error: error ? String(error) : null,
    };
    if (error && errorCode) res.errorCode = String(errorCode);
    return res;
  }

  static createEvent(source: string, target: string, action: string, payload: any = {}): IpcMessageData {
    return {
      protocol: PROTOCOL_VERSION,
      type: 'event',
      id: generateId(),
      source,
      target,
      action,
      payload,
      error: null,
    };
  }

  static isValid(msg: any): msg is IpcMessageData {
    return !!(msg && msg.protocol === PROTOCOL_VERSION && msg.type && msg.source && msg.target);
  }
}
