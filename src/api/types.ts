export type SubscriptionStatus = "none" | "active" | "cancelled" | string;

export type UsageResponse = {
  used: number;
  limit: number;
  subscription_status: SubscriptionStatus;
};

export type SubscribeResponse =
  | { status: "active" }
  | { status: "checkout"; checkout_url: string };

export type KeyResponse = {
  key: string;
};

export type ApiError = {
  error: string;
};

export type ModelObject = {
  id: string;
  object: "model" | string;
  created: number;
  owned_by: string;
};

export type ModelsListResponse = {
  object: "list" | string;
  data: ModelObject[];
};
