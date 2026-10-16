# Event-Driven Werkorder Notificatiesysteem

Dit project bevat een complete real-time event-driven architectuure.

##   Snille Start

1. Start de containers:
   ```bash
   docker compose up -d
   ```

2. Open de browser op `http://localhost`

3. Start de producer simulator:
   ```bash
   npm instang kafkajsk
   node producer.js
   ```J