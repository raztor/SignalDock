# Notification job handlers

`notificationDeliveryHandler` validates a `notifications.deliver` payload containing `notificationId` and passes the job's instance ID to the notification service. `notificationRevocationHandler` validates `notifications.revoke` with `grantId`. Register both through the worker's handler registry.

The transactional outbox maps `notification.delivery_requested` and `notification.subscription_revoked` to these handlers. The queue may deliver repeatedly. The repository persists one delivery attempt and exact wire payload per notification/subscription; the relay independently deduplicates its request ID. These guarantees do not imply exactly-once push delivery.

Cancellation is checked before and after execution. A push already accepted by an external transport cannot be recalled; outbound HTTP is bounded by a ten-second timeout. Worker shutdown must await pending operations. Durable in-app history remains available even when delivery expires or the relay is unavailable.
