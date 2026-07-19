import type { LoggingPreset, RequestObservability, TraceContext } from "./types.js";

export function correlationFields(context: RequestObservability, preset: LoggingPreset): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  fields["request_id"] = context.requestId;
  fields["correlation_id"] = context.correlationId;
  const trace = context.traceContext;
  if (trace === null) {
    return fields;
  }
  fields["trace_id"] = trace.traceId;
  fields["parent_id"] = trace.parentId;
  fields["trace_flags"] = trace.flags;
  fields["trace_sampled"] = trace.sampled;
  if (trace.traceIdRandom !== undefined) {
    fields["trace_id_random"] = trace.traceIdRandom;
  }
  addProviderFields(fields, trace, preset);
  return fields;
}

function addProviderFields(fields: Record<string, unknown>, trace: TraceContext, preset: LoggingPreset): void {
  if (preset === "gcp") {
    // Cloud Trace's current preferred format is the bare W3C trace ID.
    // Do not prepend projects/{project}/traces/ to this value.
    fields["logging.googleapis.com/trace"] = trace.traceId;
    fields["logging.googleapis.com/trace_sampled"] = trace.sampled;
  } else if (preset === "aws") {
    fields["xray_trace_id"] = `1-${trace.traceId.slice(0, 8)}-${trace.traceId.slice(8)}`;
  } else if (preset === "azure") {
    fields["operation_Id"] = trace.traceId;
    fields["operation_ParentId"] = trace.parentId;
  }
}
