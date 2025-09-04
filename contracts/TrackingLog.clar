;; TrackingLog.clar
;; Core contract for logging drone delivery tracking events in MediDrone.
;; This contract handles immutable logging of delivery status updates, GPS positions,
;; timestamps, and other critical events. It supports oracle integrations for automated
;; IoT updates and ensures only authorized parties (e.g., operators, oracles) can log events.
;; Features include event sequencing, tamper-proof logs, query functions, and access controls.

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-DELIVERY-ID u101)
(define-constant ERR-INVALID-STATUS u102)
(define-constant ERR-INVALID-GPS u103)
(define-constant ERR-SEQUENCE-MISMATCH u104)
(define-constant ERR-DELIVERY-COMPLETED u105)
(define-constant ERR-INVALID-PAYLOAD-HASH u106)
(define-constant ERR-INVALID-ORACLE u107)
(define-constant ERR-PAUSED u108)
(define-constant ERR-INVALID-TIMESTAMP u109)
(define-constant ERR-MAX-LOGS-EXCEEDED u110)
(define-constant ERR-INVALID-ROLE u111)
(define-constant ERR-ALREADY-INITIALIZED u112)

(define-constant STATUS-PENDING "pending")
(define-constant STATUS-ASSIGNED "assigned")
(define-constant STATUS-IN_TRANSIT "in-transit")
(define-constant STATUS-DELAYED "delayed")
(define-constant STATUS-ARRIVED "arrived")
(define-constant STATUS-DELIVERED "delivered")
(define-constant STATUS-FAILED "failed")
(define-constant STATUS-CANCELLED "cancelled")

(define-constant ROLE-OPERATOR u1)
(define-constant ROLE-ORACLE u2)
(define-constant ROLE-ADMIN u3)
(define-constant ROLE-SUPPLIER u4)
(define-constant ROLE-RECIPIENT u5)

(define-constant MAX-LOGS-PER-DELIVERY u100) ;; Limit to prevent storage bloat

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var contract-paused bool false)
(define-data-var log-counter uint u0)
(define-data-var oracle-registry (list 10 principal) (list))

;; Data Maps
(define-map delivery-logs
  { delivery-id: uint }
  {
    status: (string-ascii 32),
    operator: principal,
    supplier: principal,
    recipient: principal,
    start-timestamp: uint,
    expected-arrival: uint,
    actual-arrival: (optional uint),
    payload-hash: (buff 32), ;; Hash of medical supplies details
    log-sequence: uint, ;; Current sequence number for logs
    completed: bool,
    failure-reason: (optional (string-utf8 200))
  }
)

(define-map event-logs
  { delivery-id: uint, sequence: uint }
  {
    timestamp: uint,
    gps-lat: (string-ascii 20),
    gps-lon: (string-ascii 20),
    altitude: uint,
    status-update: (string-ascii 32),
    updater: principal,
    notes: (string-utf8 200),
    verified-by-oracle: bool
  }
)

(define-map authorized-roles
  { user: principal, delivery-id: uint }
  { roles: (list 5 uint) } ;; List of roles for flexibility
)

;; Private Functions
(define-private (is-authorized (user principal) (delivery-id uint) (required-role uint))
  (let ((roles (default-to (list) (get roles (map-get? authorized-roles {user: user, delivery-id: delivery-id})))))
    (or (is-eq user (var-get contract-owner))
        (is-some (index-of roles required-role))))
)

(define-private (validate-status (status (string-ascii 32)))
  (or (is-eq status STATUS-PENDING)
      (is-eq status STATUS-ASSIGNED)
      (is-eq status STATUS-IN_TRANSIT)
      (is-eq status STATUS-DELAYED)
      (is-eq status STATUS-ARRIVED)
      (is-eq status STATUS-DELIVERED)
      (is-eq status STATUS-FAILED)
      (is-eq status STATUS-CANCELLED))
)

(define-private (validate-gps (lat (string-ascii 20)) (lon (string-ascii 20)))
  (and (> (len lat) u0) (> (len lon) u0))
)

(define-private (is-oracle (user principal))
  (is-some (index-of (var-get oracle-registry) user))
)

;; Public Functions
(define-public (initialize-delivery 
  (delivery-id uint)
  (operator principal)
  (supplier principal)
  (recipient principal)
  (expected-arrival uint)
  (payload-hash (buff 32)))
  (let ((existing (map-get? delivery-logs {delivery-id: delivery-id})))
    (if (is-some existing)
        (err ERR-ALREADY-INITIALIZED)
        (if (var-get contract-paused)
            (err ERR-PAUSED)
            (begin
              (map-set delivery-logs
                {delivery-id: delivery-id}
                {
                  status: STATUS-PENDING,
                  operator: operator,
                  supplier: supplier,
                  recipient: recipient,
                  start-timestamp: block-height,
                  expected-arrival: expected-arrival,
                  actual-arrival: none,
                  payload-hash: payload-hash,
                  log-sequence: u0,
                  completed: false,
                  failure-reason: none
                }
              )
              ;; Assign roles
              (map-set authorized-roles {user: tx-sender, delivery-id: delivery-id} {roles: (list ROLE-ADMIN)})
              (map-set authorized-roles {user: operator, delivery-id: delivery-id} {roles: (list ROLE-OPERATOR)})
              (map-set authorized-roles {user: supplier, delivery-id: delivery-id} {roles: (list ROLE-SUPPLIER)})
              (map-set authorized-roles {user: recipient, delivery-id: delivery-id} {roles: (list ROLE-RECIPIENT)})
              (ok true)
            )
        )
    )
  )
)

(define-public (log-event 
  (delivery-id uint)
  (gps-lat (string-ascii 20))
  (gps-lon (string-ascii 20))
  (altitude uint)
  (status-update (string-ascii 32))
  (notes (string-utf8 200)))
  (let ((delivery (unwrap! (map-get? delivery-logs {delivery-id: delivery-id}) (err ERR-INVALID-DELIVERY-ID)))
        (current-sequence (get log-sequence delivery))
        (new-sequence (+ current-sequence u1))
        (is-oracle-update (is-oracle tx-sender)))
    (if (var-get contract-paused)
        (err ERR-PAUSED)
        (if (get completed delivery)
            (err ERR-DELIVERY-COMPLETED)
            (if (or (is-authorized tx-sender delivery-id ROLE-OPERATOR) is-oracle-update)
                (if (and (validate-status status-update) (validate-gps gps-lat gps-lon))
                    (if (< current-sequence MAX-LOGS-PER-DELIVERY)
                        (begin
                          (map-set event-logs
                            {delivery-id: delivery-id, sequence: new-sequence}
                            {
                              timestamp: block-height,
                              gps-lat: gps-lat,
                              gps-lon: gps-lon,
                              altitude: altitude,
                              status-update: status-update,
                              updater: tx-sender,
                              notes: notes,
                              verified-by-oracle: is-oracle-update
                            }
                          )
                          (map-set delivery-logs
                            {delivery-id: delivery-id}
                            (merge delivery 
                              {
                                status: status-update,
                                log-sequence: new-sequence
                              }
                            )
                          )
                          ;; If delivered or failed, mark completed
                          (if (or (is-eq status-update STATUS-DELIVERED) (is-eq status-update STATUS-FAILED) (is-eq status-update STATUS-CANCELLED))
                              (map-set delivery-logs {delivery-id: delivery-id} (merge delivery {completed: true, actual-arrival: (some block-height)}))
                              true
                          )
                          (ok new-sequence)
                        )
                        (err ERR-MAX-LOGS-EXCEEDED)
                    )
                    (err ERR-INVALID-STATUS)
                )
                (err ERR-UNAUTHORIZED)
            )
        )
    )
  )
)

(define-public (log-failure 
  (delivery-id uint)
  (reason (string-utf8 200)))
  (let ((delivery (unwrap! (map-get? delivery-logs {delivery-id: delivery-id}) (err ERR-INVALID-DELIVERY-ID))))
    (if (var-get contract-paused)
        (err ERR-PAUSED)
        (if (get completed delivery)
            (err ERR-DELIVERY-COMPLETED)
            (if (is-authorized tx-sender delivery-id ROLE-OPERATOR)
                (begin
                  (map-set delivery-logs
                    {delivery-id: delivery-id}
                    (merge delivery 
                      {
                        status: STATUS-FAILED,
                        completed: true,
                        failure-reason: (some reason)
                      }
                    )
                  )
                  (ok true)
                )
                (err ERR-UNAUTHORIZED)
            )
        )
    )
  )
)

(define-public (add-oracle (oracle principal))
  (if (is-eq tx-sender (var-get contract-owner))
      (begin
        (var-set oracle-registry (unwrap! (as-max-len? (append (var-get oracle-registry) oracle) u10) (err ERR-INVALID-ORACLE)))
        (ok true)
      )
      (err ERR-UNAUTHORIZED)
  )
)

(define-public (remove-oracle (oracle principal))
  (if (is-eq tx-sender (var-get contract-owner))
      (let ((current-oracles (var-get oracle-registry)))
        (var-set oracle-registry (filter (lambda (o) (not (is-eq o oracle))) current-oracles))
        (ok true)
      )
      (err ERR-UNAUTHORIZED)
  )
)

(define-public (pause-contract)
  (if (is-eq tx-sender (var-get contract-owner))
      (begin
        (var-set contract-paused true)
        (ok true)
      )
      (err ERR-UNAUTHORIZED)
  )
)

(define-public (unpause-contract)
  (if (is-eq tx-sender (var-get contract-owner))
      (begin
        (var-set contract-paused false)
        (ok true)
      )
      (err ERR-UNAUTHORIZED)
  )
)

(define-public (assign-role (user principal) (delivery-id uint) (role uint))
  (let ((delivery (unwrap! (map-get? delivery-logs {delivery-id: delivery-id}) (err ERR-INVALID-DELIVERY-ID))))
    (if (is-authorized tx-sender delivery-id ROLE-ADMIN)
        (let ((current-roles (default-to (list) (get roles (map-get? authorized-roles {user: user, delivery-id: delivery-id})))))
          (map-set authorized-roles {user: user, delivery-id: delivery-id} {roles: (unwrap! (as-max-len? (append current-roles role) u5) (err ERR-INVALID-ROLE))})
          (ok true)
        )
        (err ERR-UNAUTHORIZED)
    )
  )
)

(define-public (remove-role (user principal) (delivery-id uint) (role uint))
  (let ((delivery (unwrap! (map-get? delivery-logs {delivery-id: delivery-id}) (err ERR-INVALID-DELIVERY-ID))))
    (if (is-authorized tx-sender delivery-id ROLE-ADMIN)
        (let ((current-roles (default-to (list) (get roles (map-get? authorized-roles {user: user, delivery-id: delivery-id})))))
          (map-set authorized-roles {user: user, delivery-id: delivery-id} {roles: (filter (lambda (r) (not (is-eq r role))) current-roles)})
          (ok true)
        )
        (err ERR-UNAUTHORIZED)
    )
  )
)

;; Read-Only Functions
(define-read-only (get-delivery-details (delivery-id uint))
  (map-get? delivery-logs {delivery-id: delivery-id})
)

(define-read-only (get-event-log (delivery-id uint) (sequence uint))
  (map-get? event-logs {delivery-id: delivery-id, sequence: sequence})
)

(define-read-only (get-latest-sequence (delivery-id uint))
  (match (map-get? delivery-logs {delivery-id: delivery-id})
    some-delivery (ok (get log-sequence some-delivery))
    none (err ERR-INVALID-DELIVERY-ID)
  )
)

(define-read-only (is-delivery-completed (delivery-id uint))
  (match (map-get? delivery-logs {delivery-id: delivery-id})
    some-delivery (ok (get completed some-delivery))
    none (err ERR-INVALID-DELIVERY-ID)
  )
)

(define-read-only (get-oracles)
  (ok (var-get oracle-registry))
)

(define-read-only (has-role (user principal) (delivery-id uint) (role uint))
  (let ((roles (default-to (list) (get roles (map-get? authorized-roles {user: user, delivery-id: delivery-id})))))
    (ok (is-some (index-of roles role))))
)

(define-read-only (get-contract-paused)
  (ok (var-get contract-paused))
)

(define-read-only (get-contract-owner)
  (ok (var-get contract-owner))
)