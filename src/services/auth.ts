import { FastifyReply, FastifyRequest } from 'fastify';
import { AgentService } from './agentService.js';

export const resolveAgentFromKey = (
  request: FastifyRequest,
  reply: FastifyReply,
  agentService: AgentService,
): { id: string; name: string } | undefined => {
  const key = request.headers['x-agent-api-key'];
  if (!key || typeof key !== 'string') {
    void reply.code(401).send({
      error: 'missing_agent_api_key',
      message: 'Provide x-agent-api-key header from /agents/register response.',
    });
    return undefined;
  }

  const agent = agentService.findByApiKey(key);
  if (!agent) {
    void reply.code(401).send({
      error: 'invalid_agent_api_key',
    });
    return undefined;
  }

  return { id: agent.id, name: agent.name };
};
