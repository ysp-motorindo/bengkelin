import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type {
  OwnershipTransferInput,
  SaveVehicleData,
  SaveVehicleResult,
  SearchVehiclesInput,
  SearchVehiclesResult,
  VehicleDetailDto,
  VehicleDto,
  VehicleIdInput,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { CustomerRepository } from '@/main/features/customers/repository';
import { normalizePlate } from './normalization';
import { VehicleRepository, type VehicleFields } from './repository';

export interface VehicleServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
}

const DEFAULT_LIMIT = 25;

/**
 * Vehicles and ownership (spec 7, 8, 36, 51). Plate is the search key, the
 * UUID the identity. Ownership changes ONLY through `transferOwnership` (or by
 * creating a brand-new vehicle for a customer): never implicitly.
 */
export class VehicleService {
  private readonly repo: VehicleRepository;
  private readonly customers: CustomerRepository;
  private readonly newId: () => string;

  constructor(private readonly deps: VehicleServiceDeps) {
    this.repo = new VehicleRepository(deps.db);
    this.customers = new CustomerRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  /** Global lookup across all owners; tolerates spacing/case/punctuation. */
  searchByPlate(
    session: Session | undefined,
    input: SearchVehiclesInput,
  ): SearchVehiclesResult {
    requireSession(session);
    const normalized = normalizePlate(input.query);
    if (normalized === '') return { results: [] };
    return {
      results: this.repo.searchByPlate(
        normalized,
        input.limit ?? DEFAULT_LIMIT,
      ),
    };
  }

  get(session: Session | undefined, input: VehicleIdInput): VehicleDetailDto {
    requireSession(session);
    return this.detail(input.id);
  }

  save(
    session: Session | undefined,
    input: SaveVehicleData,
  ): SaveVehicleResult {
    const actor = requireSession(session);
    return withWriteTransaction(this.deps.db, () => {
      const now = this.deps.clock.now();
      const normalizedPlateNumber = normalizePlate(input.plateNumber);
      const existingWithPlate = this.repo.findByNormalizedPlate(
        normalizedPlateNumber,
      );

      if (input.id === undefined && existingWithPlate) {
        // Reuse: never a second row, never an implicit ownership change.
        return {
          vehicle: existingWithPlate,
          reusedExisting: true,
          warning: 'PLATE_EXISTS',
        };
      }

      const current = input.id ? this.mustFind(input.id) : undefined;
      if (existingWithPlate && existingWithPlate.id !== current?.id) {
        throw new DomainError('PLATE_EXISTS', 'Plate number already exists');
      }

      const modelId = input.vehicleModelId ?? null;
      // An unchanged model may stay even if it has since been deactivated.
      if (modelId !== (current?.vehicleModelId ?? null)) {
        this.assertModelUsable(input.brandId ?? null, modelId);
      }
      const fields: VehicleFields = {
        plateNumber: input.plateNumber,
        normalizedPlateNumber,
        vehicleModelId: modelId,
        year: input.year ?? null,
        color: input.color,
        notes: input.notes,
      };

      if (current) {
        this.repo.update(current.id, fields, now);
        this.audit(actor, 'VEHICLE_UPDATED', current.id, {});
        return {
          vehicle: this.mustFind(current.id),
          reusedExisting: false,
          warning: null,
        };
      }

      const ownerId = input.ownerCustomerId ?? null;
      if (ownerId && !this.customers.find(ownerId)) {
        throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found');
      }
      const id = this.newId();
      this.repo.insert(id, fields, now);
      if (ownerId) this.repo.openOwnership(this.newId(), id, ownerId, now);
      this.audit(actor, 'VEHICLE_CREATED', id, { withOwner: ownerId !== null });
      return {
        vehicle: this.mustFind(id),
        reusedExisting: false,
        warning: null,
      };
    });
  }

  /**
   * The explicit ownership change. Closes the active ownership at the clock
   * instant and opens the new one at the same instant, atomically. With no
   * active owner it opens the first ownership.
   */
  transferOwnership(
    session: Session | undefined,
    input: OwnershipTransferInput,
  ): VehicleDetailDto {
    const actor = requireSession(session);
    const work = (): VehicleDetailDto => {
      const now = this.deps.clock.now();
      this.mustFind(input.vehicleId);
      if (!this.customers.find(input.newCustomerId)) {
        throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found');
      }
      const active = this.repo.activeOwnership(input.vehicleId);
      if (active?.customerId === input.newCustomerId) {
        throw new DomainError(
          'ALREADY_OWNER',
          'Customer already owns the vehicle',
        );
      }
      if (active) {
        if (now <= active.effectiveFrom) {
          throw new DomainError(
            'OWNERSHIP_TRANSFER_TOO_SOON',
            'The current ownership began at this same instant',
          );
        }
        this.repo.closeOwnership(active.id, now);
      }
      this.repo.openOwnership(
        this.newId(),
        input.vehicleId,
        input.newCustomerId,
        now,
      );
      this.audit(actor, 'VEHICLE_OWNERSHIP_TRANSFERRED', input.vehicleId, {
        fromCustomerId: active?.customerId ?? null,
        toCustomerId: input.newCustomerId,
      });
      return this.detail(input.vehicleId);
    };
    return withWriteTransaction(this.deps.db, () =>
      input.requestId
        ? runIdempotent(
            this.deps.db,
            {
              requestId: input.requestId,
              command: 'vehicles.transferOwnership',
              actorCashierId: actor.cashierId,
              clock: this.deps.clock,
            },
            work,
          )
        : work(),
    );
  }

  private assertModelUsable(brandId: string | null, modelId: string | null) {
    if (modelId === null) return;
    const model = this.repo.findModelWithBrand(modelId);
    if (!model) {
      throw new DomainError('REFERENCE_NOT_FOUND', 'Vehicle model not found');
    }
    if (brandId === null || model.brandId !== brandId) {
      throw new DomainError(
        'INVALID_BRAND_MODEL',
        'The model does not belong to the selected brand',
      );
    }
    if (!model.modelActive || !model.brandActive) {
      throw new DomainError('REFERENCE_INACTIVE', 'Brand or model is inactive');
    }
  }

  private detail(id: string): VehicleDetailDto {
    return {
      vehicle: this.mustFind(id),
      ownerships: this.repo.ownershipHistory(id),
    };
  }

  private mustFind(id: string): VehicleDto {
    const found = this.repo.find(id);
    if (!found) throw new DomainError('VEHICLE_NOT_FOUND', 'Vehicle not found');
    return found;
  }

  /** Metadata: ids and flags only. */
  private audit(
    actor: Session,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): void {
    appendAudit(this.deps.db, this.deps.clock, {
      cashierId: actor.cashierId,
      action,
      entityType: 'vehicle',
      entityId,
      metadata,
    });
  }
}
