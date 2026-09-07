export type SubscriptionStatus =
  | "none"
  | "pending"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired"
  | "review_required";

export type UsageResponse = {
  used: number;
  limit: number;
  subscription_status: SubscriptionStatus;
  entitlement_status: SubscriptionStatus;
  cancel_at_period_end: boolean;
  access_until: string | null;
  required_billing_action: "subscribe" | "none" | "uncancel" | "update_payment" | "contact_support";
};

export type SubscribeResponse = {
  status: "checkout";
  checkout_url: string;
  expires_at: string;
};

export type CancelSubscriptionResponse = {
  status: string;
  cancel_at_period_end: boolean;
  access_until: string | null;
};

export type KeyResponse = {
  key: string;
};

export type ApiError = { error: { code: string; message: string; request_id: string } };

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
