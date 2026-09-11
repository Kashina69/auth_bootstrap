import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/**
 * Single error shape for every failure. Non-HttpException details (driver errors, stack
 * traces) are logged server-side only and never sent to the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const response = context.getResponse<FastifyReply>();
    const status = resolveHttpStatus(exception);
    logFailure(this.logger, `${request.method} ${request.url} -> ${status}`, describeForLog(exception), status);
    response.code(status).send(buildErrorResponse(exception, request.url, status));
  }
}

function resolveHttpStatus(exception: unknown): number {
  return exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
}

/** A 4xx is the client's problem, not a server fault — only 5xx is worth an error-level alert. */
function logFailure(logger: Logger, summary: string, detail: string, status: number): void {
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) logger.error(summary, detail);
  else logger.warn(summary);
}

function buildErrorResponse(exception: unknown, path: string, status: number): ErrorResponse {
  return {
    statusCode: status,
    error: resolveErrorLabel(exception),
    message: resolveErrorMessage(exception),
    path,
    timestamp: new Date().toISOString(),
  };
}

function resolveErrorLabel(exception: unknown): string {
  if (!(exception instanceof HttpException)) return 'Internal Server Error';
  const body = exception.getResponse();
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return exception.name;
}

function resolveErrorMessage(exception: unknown): string | string[] {
  if (!(exception instanceof HttpException)) return 'Internal server error';
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  if (isRecord(body) && body.message !== undefined) return normalizeMessage(body.message);
  return exception.message;
}

function normalizeMessage(message: unknown): string | string[] {
  return Array.isArray(message) ? message.map(String) : String(message);
}

function describeForLog(exception: unknown): string {
  return exception instanceof Error ? `${exception.stack ?? exception.message}` : String(exception);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
