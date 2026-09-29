import { z } from 'zod';
import type { Config } from './config.js';
import { MediaBridgeClient, type MediaTransport, validatedControlBaseUrl } from './media-client.js';

const nodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  controlBaseUrl: z.string().url(),
  turnUdpUrl: z.string().min(1),
  turnTlsUrl: z.string().min(1),
  probeUrl: z.string().url().optional(),
  mediaSecret: z.string().min(32),
  turnSecret: z.string().min(32),
  recordingBaseUrl: z.string().url().optional(),
});
export type MediaNodeDefinition = z.infer<typeof nodeSchema>;

export class MediaNodeRegistry {
  private readonly nodes = new Map<string, {definition: MediaNodeDefinition; client: MediaBridgeClient}>();
  readonly defaultNodeId: string;
  constructor(definitions: MediaNodeDefinition[], defaultNodeId = 'relay-primary') {
    if (!definitions.length) throw new Error('At least one media node is required');
    for (const raw of definitions) {
      const parsed = nodeSchema.parse(raw);
      const definition = {...parsed,controlBaseUrl:validatedControlBaseUrl(parsed.controlBaseUrl),...(parsed.recordingBaseUrl?{recordingBaseUrl:validatedControlBaseUrl(parsed.recordingBaseUrl)}:{})};
      if (this.nodes.has(definition.id)) throw new Error(`Duplicate media node: ${definition.id}`);
      this.nodes.set(definition.id, {definition, client:new MediaBridgeClient(definition.mediaSecret, definition.turnSecret, definition)});
    }
    if (!this.nodes.has(defaultNodeId)) throw new Error('Default media node is not configured');
    this.defaultNodeId = defaultNodeId;
  }
  static fromConfig(config: Config): MediaNodeRegistry | null {
    const definitions: MediaNodeDefinition[] = [];
    if (config.MEDIA_NODES_JSON) {
      let raw: unknown;
      try { raw = JSON.parse(config.MEDIA_NODES_JSON); } catch { throw new Error('MEDIA_NODES_JSON is invalid JSON'); }
      definitions.push(...z.array(nodeSchema).min(1).parse(raw));
    }
    if (config.MEDIA_SECRET && config.TURN_SECRET && !definitions.some(node => node.id === 'relay-primary')) definitions.push({
      id:'relay-primary', controlBaseUrl:'http://127.0.0.1:16881',
      turnUdpUrl:'turn:relay-secondary.example.com:16801?transport=udp',
      turnTlsUrl:'turns:relay-secondary.example.com:16802?transport=tcp',
      mediaSecret:config.MEDIA_SECRET, turnSecret:config.TURN_SECRET,
    });
    if (!definitions.length) return null;
    return new MediaNodeRegistry(definitions, config.MEDIA_DEFAULT_NODE_ID);
  }
  choose(preferred?: string): string {
    const id = preferred ?? this.defaultNodeId;
    if (!this.nodes.has(id)) throw new MediaNodeNotFoundError(id);
    return id;
  }
  client(nodeId: string | null | undefined) {
    const id = nodeId ?? 'relay-primary';
    const node = this.nodes.get(id);
    if (!node) throw new MediaNodeNotFoundError(id);
    return node.client;
  }
  recordingBaseUrl(nodeId: string) { const node=this.nodes.get(nodeId);if(!node)throw new MediaNodeNotFoundError(nodeId);return node.definition.recordingBaseUrl; }
  recordingSecret(nodeId: string) { const node=this.nodes.get(nodeId);if(!node)throw new MediaNodeNotFoundError(nodeId);return node.definition.mediaSecret; }
  nodeIds() { return [...this.nodes.keys()]; }
  probeNodes() { return [...this.nodes.values()].filter(node=>node.definition.probeUrl).map(node=>({id:node.definition.id,probeUrl:node.definition.probeUrl!,secret:node.definition.mediaSecret})); }
  qualityProbeNodes() { return [...this.nodes.values()].filter(node=>node.definition.probeUrl).map(({definition:n})=>({id:n.id,probeUrl:n.probeUrl!,secret:n.mediaSecret,turnUdpUrl:n.turnUdpUrl,turnSecret:n.turnSecret})); }
  iceServers(nodeId: string, transport: MediaTransport) { return this.client(nodeId).iceServers(transport); }
  offer(nodeId: string, callId: string, role: 'client'|'gateway', offer: {type:'offer';sdp:string}, mediaEpoch: number, replace = false) { return this.client(nodeId).offer(callId, role, offer, mediaEpoch, replace); }
  close(callId: string, nodeId = 'relay-primary', mediaEpoch = 1) { return this.client(nodeId).close(callId, mediaEpoch); }
}
export class MediaNodeNotFoundError extends Error { constructor(public readonly nodeId: string) { super('Media node is not configured'); } }
