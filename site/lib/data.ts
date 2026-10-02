// The generated build log, typed. Written by scripts/generate.ts before dev and build.

import raw from "../generated/build-log.json";
import type { BuildLog, Decision } from "./types.ts";

export const buildLog = raw as unknown as BuildLog;

export const decisionById = (id: string): Decision | undefined => buildLog.decisions.find((d) => d.id === id);
