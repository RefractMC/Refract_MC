//! Process-wide ownership for destructive maintenance. Instance operations and
//! independent account/runtime/storage work hold shared leases. Reset can start
//! only with no leases and rejects new work until its last owner is released.

use std::cell::RefCell;
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

const BUSY: &str = "Launcher maintenance is in progress. Wait for it to finish before retrying.";
const ACTIVE: &str =
    "Stop running games and wait for active launcher work to finish before resetting, updating or quitting.";

#[derive(Clone, Default)]
struct Gate(Arc<RwLock<()>>);

enum LeaseKind {
    Shared { _permit: OwnedRwLockReadGuard<()> },
    Maintenance { _owner: Arc<Owner> },
}

pub struct Lease {
    _kind: LeaseKind,
}

struct Owner {
    gate: Gate,
    _permit: OwnedRwLockWriteGuard<()>,
}

pub struct Exclusive {
    owner: Arc<Owner>,
}

thread_local! {
    static OWNER: RefCell<Option<Weak<Owner>>> = const { RefCell::new(None) };
}

fn gate() -> &'static Gate {
    static GATE: OnceLock<Gate> = OnceLock::new();
    GATE.get_or_init(Gate::default)
}

impl Gate {
    fn shared(&self) -> Result<Lease, String> {
        if let Some(owner) = OWNER.with(|current| current.borrow().as_ref().and_then(Weak::upgrade))
        {
            if Arc::ptr_eq(&owner.gate.0, &self.0) {
                return Ok(Lease {
                    _kind: LeaseKind::Maintenance { _owner: owner },
                });
            }
        }
        self.0
            .clone()
            .try_read_owned()
            .map(|permit| Lease {
                _kind: LeaseKind::Shared { _permit: permit },
            })
            .map_err(|_| BUSY.into())
    }

    fn exclusive(&self) -> Result<Exclusive, String> {
        self.0
            .clone()
            .try_write_owned()
            .map(|permit| Exclusive {
                owner: Arc::new(Owner {
                    gate: self.clone(),
                    _permit: permit,
                }),
            })
            .map_err(|_| ACTIVE.into())
    }
}

pub fn shared() -> Result<Lease, String> {
    gate().shared()
}
pub fn exclusive() -> Result<Exclusive, String> {
    gate().exclusive()
}

#[cfg(test)]
pub(crate) fn isolated_exclusive() -> Exclusive {
    Gate::default().exclusive().unwrap()
}

impl Exclusive {
    /// Only trusted synchronous maintenance code inherits this ownership.
    /// RAII restores the previous scope even if a maintenance callback panics.
    /// Borrowed leases retain the write owner if they outlive this callback.
    pub fn scope<T>(&self, action: impl FnOnce() -> T) -> T {
        struct Restore(Option<Weak<Owner>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                OWNER.with(|owner| *owner.borrow_mut() = self.0.take());
            }
        }
        let previous = OWNER.with(|owner| owner.replace(Some(Arc::downgrade(&self.owner))));
        let _restore = Restore(previous);
        action()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusive_maintenance_rejects_active_work_and_new_unrelated_callers() {
        let gate = Gate::default();
        let shared = gate.shared().unwrap();
        assert!(gate.exclusive().is_err());
        drop(shared);
        let exclusive = gate.exclusive().unwrap();
        assert!(gate.shared().is_err());
        let other = gate.clone();
        std::thread::spawn(move || assert!(other.shared().is_err()))
            .join()
            .unwrap();
        exclusive.scope(|| assert!(gate.shared().is_ok()));
        drop(exclusive);
        assert!(gate.shared().is_ok());
    }

    #[test]
    fn borrowed_maintenance_lease_and_cancelled_waiter_retain_ownership() {
        let gate = Gate::default();
        let owner = gate.exclusive().unwrap();
        let borrowed = owner.scope(|| gate.shared().unwrap());
        drop(owner);
        assert!(gate.shared().is_err());
        drop(borrowed);
        let lease = gate.shared().unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _lease = lease;
            started.send(()).unwrap();
            wait.recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        });
        ready
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(gate.exclusive().is_err());
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(gate.exclusive().is_ok());
    }

    #[test]
    fn panicking_scope_restores_ownership_without_granting_access_to_other_gates() {
        let gate = Gate::default();
        let other = Gate::default();
        let owner = gate.exclusive().unwrap();
        let _other = other.exclusive().unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            owner.scope(|| {
                assert!(other.shared().is_err());
                panic!("synthetic maintenance failure");
            })
        }));
        assert!(result.is_err());
        assert!(gate.shared().is_err());
        drop(owner);
        assert!(gate.shared().is_ok());
    }
}
