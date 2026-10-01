import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType, ReactNode } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

export type AccountAction = Readonly<{
  id: string;
  title: string;
  icon?: ReactNode;
  component: ComponentType<{
    open: boolean;
    onOpenChange(open: boolean): void;
  }>;
}>;
export type RegisteredAccountAction = Contribution<AccountAction>;
export class AccountActionsService extends Service {
  private readonly actions;
  constructor(ctx: Context) {
    super(ctx, "accountActions");
    this.actions = createContributions<AccountAction>(ctx);
  }
  snapshot = () => this.actions.snapshot();
  subscribe = (listener: () => void) => this.actions.subscribe(listener);
  register(action: AccountAction) {
    if (
      !action ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(action.id) ||
      !action.title?.trim() ||
      typeof action.component !== "function"
    )
      throw new Error("An account action needs an id, title and component");
    this.actions.register(this.ctx, action);
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    accountActions: AccountActionsService;
  }
}
