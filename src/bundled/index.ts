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
import roomsManifest from "./rooms/manifest.json";
import * as rooms from "./rooms";
import projectsManifest from "./projects/manifest.json";
import * as projects from "./projects";
import type { BundledPlugin } from "../plugins/manager";

export const bundledPlugins: readonly BundledPlugin[] = [
  { manifest: { ...mentionsManifest, apiVersion: 1 }, module: mentions },
  { manifest: { ...emojiManifest, apiVersion: 1 }, module: emoji },
  { manifest: { ...channelsManifest, apiVersion: 1 }, module: channels },
  { manifest: { ...githubManifest, apiVersion: 1 }, module: github },
  { manifest: { ...bestieManifest, apiVersion: 1 }, module: bestie },
  { manifest: { ...roomsManifest, apiVersion: 1 }, module: rooms },
  { manifest: { ...projectsManifest, apiVersion: 1 }, module: projects },
  { manifest: { ...agentsManifest, apiVersion: 1 }, module: agents },
];
