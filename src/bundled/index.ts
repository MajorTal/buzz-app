import activityManifest from "./agent-activity/manifest.json";
import * as activity from "./agent-activity";
import terminalManifest from "./terminal/manifest.json";
import * as terminal from "./terminal";
import profilesManifest from "./profiles/manifest.json";
import * as profiles from "./profiles";
import mentionsManifest from "./mentions/manifest.json";
import * as mentions from "./mentions";
import emojiManifest from "./emoji/manifest.json";
import * as emoji from "./emoji";
import agentsManifest from "./agents/manifest.json";
import * as agents from "./agents";
import channelsManifest from "./channels/manifest.json";
import githubManifest from "./github/manifest.json";
import * as channels from "./channels";
import * as github from "./github";
import bestieManifest from "./bestie/manifest.json";
import * as bestie from "./bestie";
import projectsManifest from "./projects/manifest.json";
import * as projects from "./projects";
import type { BundledPlugin } from "../plugins/manager";

export const bundledPlugins: readonly BundledPlugin[] = [
  { manifest: { ...activityManifest, apiVersion: 1 }, module: activity },
  { manifest: { ...terminalManifest, apiVersion: 1 }, module: terminal },
  { manifest: { ...profilesManifest, apiVersion: 1 }, module: profiles },
  { manifest: { ...mentionsManifest, apiVersion: 1 }, module: mentions },
  { manifest: { ...emojiManifest, apiVersion: 1 }, module: emoji },
  { manifest: { ...channelsManifest, apiVersion: 1 }, module: channels },
  { manifest: { ...githubManifest, apiVersion: 1 }, module: github },
  { manifest: { ...bestieManifest, apiVersion: 1 }, module: bestie },
  { manifest: { ...projectsManifest, apiVersion: 1 }, module: projects },
  { manifest: { ...agentsManifest, apiVersion: 1 }, module: agents },
];
