import { EventEmitter } from "events";
import { db } from "@/lib/db";
import { activityFeed } from "@/modules/core/schema";

// ── Event Type Definitions ──

interface DealWonEvent {
  dealId: string;
  companyId: string;
  value: number;
  userId?: string;
}

interface DealStageChangedEvent {
  dealId: string;
  fromStage: string;
  toStage: string;
  userId?: string;
}

interface OrderCreatedEvent {
  orderId: string;
  companyId: string;
  total: number;
  userId?: string;
}

interface OrderShippedEvent {
  orderId: string;
  trackingNumber?: string;
  carrier?: string;
}

interface InventoryBelowReorderEvent {
  productId: string;
  sku: string;
  currentQty: number;
  reorderPoint: number;
}

interface CustomerHealthChangedEvent {
  companyId: string;
  fromScore: string;
  toScore: string;
}

interface POStatusChangedEvent {
  poId: string;
  fromStatus: string;
  toStatus: string;
}

interface AgentCompletedEvent {
  agentType: string;
  module: string;
  durationMs: number;
  result?: Record<string, unknown>;
}

interface AgentErrorEvent {
  agentType: string;
  module: string;
  error: string;
}

interface PaymentReceivedEvent {
  paymentId: string;
  companyId: string;
  amount: number;
  invoiceId?: string;
}

interface ProductTrendChangeEvent {
  productId: string;
  metric: string;
  direction: "up" | "down";
  magnitude: number;
}

// ── Event Map ──

export interface EventMap {
  "deal.won": DealWonEvent;
  "deal.stage_changed": DealStageChangedEvent;
  "order.created": OrderCreatedEvent;
  "order.shipped": OrderShippedEvent;
  "inventory.below_reorder": InventoryBelowReorderEvent;
  "customer.health_changed": CustomerHealthChangedEvent;
  "po.status_changed": POStatusChangedEvent;
  "agent.completed": AgentCompletedEvent;
  "agent.error": AgentErrorEvent;
  "payment.received": PaymentReceivedEvent;
  "product.trend_change": ProductTrendChangeEvent;
}

export type EventType = keyof EventMap;

// ── Module mapping for activity feed ──

const eventModuleMap: Record<EventType, string> = {
  "deal.won": "sales",
  "deal.stage_changed": "sales",
  "order.created": "orders",
  "order.shipped": "orders",
  "inventory.below_reorder": "inventory",
  "customer.health_changed": "customers",
  "po.status_changed": "inventory",
  "agent.completed": "intelligence",
  "agent.error": "intelligence",
  "payment.received": "finance",
  "product.trend_change": "catalog",
};

// ── TypedEventBus ──

class TypedEventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(20); // Per CTO review
  }

  emit<T extends EventType>(eventType: T, data: EventMap[T]): void {
    this.emitter.emit(eventType, data);

    // Persist to activity_feed asynchronously — don't block caller
    setImmediate(() => {
      try {
        db.insert(activityFeed).values({
          eventType,
          module: eventModuleMap[eventType],
          entityType: this.extractEntityType(eventType),
          entityId: this.extractEntityId(eventType, data),
          data: data as unknown as Record<string, unknown>,
          userId: (data as unknown as Record<string, unknown>).userId as string | undefined,
        }).run();
      } catch (err) {
        console.error(`[EventBus] Failed to persist event ${eventType}:`, err);
      }
    });
  }

  on<T extends EventType>(eventType: T, handler: (data: EventMap[T]) => void): void {
    this.emitter.on(eventType, handler);
  }

  off<T extends EventType>(eventType: T, handler: (data: EventMap[T]) => void): void {
    this.emitter.off(eventType, handler);
  }

  once<T extends EventType>(eventType: T, handler: (data: EventMap[T]) => void): void {
    this.emitter.once(eventType, handler);
  }

  private extractEntityType(eventType: EventType): string {
    return eventType.split(".")[0];
  }

  private extractEntityId<T extends EventType>(eventType: T, data: EventMap[T]): string | undefined {
    const d = data as unknown as Record<string, unknown>;
    return (d.dealId ?? d.orderId ?? d.companyId ?? d.poId ?? d.productId ?? d.paymentId) as string | undefined;
  }
}

export const eventBus = new TypedEventBus();
