import type { Page } from "@playwright/test";

export interface PageErrors {
  /** Every page error the page reported, as evidence. */
  readonly errors: string[];
  /** Page errors that are not a reviewed engine report. */
  unexplained(): string[];
}

export function watchPageErrors(page: Page): PageErrors;
