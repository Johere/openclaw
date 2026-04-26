import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "openclaw/plugin-sdk/zod";
import type { OpenClawPluginConfigSchema } from "../api.js";
import { resolveTracesDir } from "./paths.js";

const PromptTracerConfigSource = z.object({
  enabled: z.boolean().default(true),
  tracesDir: z.string().optional(),
  maxBytesPerPrompt: z.number().int().min(1024).max(16_777_216).default(262_144),
  captureWireBody: z.boolean().default(true),
  captureImages: z.boolean().default(true),
  autoStartChannels: z.array(z.string()).default([]),
  viewer: z
    .object({
      theme: z.enum(["light", "dark"]).default("dark"),
      inlineXml: z.boolean().default(true),
    })
    .default({}),
});

export type PromptTracerConfig = {
  enabled: boolean;
  tracesDir: string;
  maxBytesPerPrompt: number;
  captureWireBody: boolean;
  captureImages: boolean;
  autoStartChannels: string[];
  viewer: {
    theme: "light" | "dark";
    inlineXml: boolean;
  };
};

const DEFAULT_CONFIG: PromptTracerConfig = {
  enabled: true,
  tracesDir: resolveTracesDir(),
  maxBytesPerPrompt: 262_144,
  captureWireBody: true,
  captureImages: true,
  autoStartChannels: [],
  viewer: {
    theme: "dark",
    inlineXml: true,
  },
};

export function resolvePromptTracerConfig(
  pluginConfig: Record<string, unknown> | undefined,
): PromptTracerConfig {
  if (!pluginConfig) {
    return DEFAULT_CONFIG;
  }
  const parsed = PromptTracerConfigSource.safeParse(pluginConfig);
  if (!parsed.success) {
    return DEFAULT_CONFIG;
  }
  const d = parsed.data;
  return {
    enabled: d.enabled,
    tracesDir: resolveTracesDir(d.tracesDir),
    maxBytesPerPrompt: d.maxBytesPerPrompt,
    captureWireBody: d.captureWireBody,
    captureImages: d.captureImages,
    autoStartChannels: d.autoStartChannels,
    viewer: {
      theme: d.viewer.theme,
      inlineXml: d.viewer.inlineXml,
    },
  };
}

const promptTracerConfigSchemaBase = buildPluginConfigSchema(PromptTracerConfigSource, {
  safeParse(value) {
    const result = PromptTracerConfigSource.safeParse(value);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error.message };
  },
});

export const promptTracerPluginConfigSchema: OpenClawPluginConfigSchema =
  promptTracerConfigSchemaBase;
