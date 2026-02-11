import { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, toErrorEnvelope } from '../errors/taxonomy.js';
import { AgentService } from './agentService.js';

export const resolveAgentFromKey = (
  request: FastifyRequest,
  reply: FastifyReply,
  agentService: AgentService,
): { id: string; name: string } | undefined => {
  const key = request.headers['x-agent-api-key'];
  if (!key || typeof key !== 'string') {
    void reply.code(401).send(toErrorEnvelope(
      ErrorCode.MissingAgentApiKey,
      'Provide x-agent-api-key header from /agents/register response.',
    ));
    return undefined;
  }

  const agent = agentService.findByApiKey(key);
  if (!agent) {
    void reply.code(401).send(toErrorEnvelope(
      ErrorCode.InvalidAgentApiKey,
      'Provided API key is not recognized.',
    ));
    return undefined;
  }

  return { id: agent.id, name: agent.name };
};
