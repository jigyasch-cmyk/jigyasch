from fastapi import FastAPI, APIRouter, HTTPException, Depends, UploadFile, File, Header, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import json
import base64
import logging
import uuid
import asyncio
import bcrypt
import jwt as pyjwt
import requests
import time
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Literal, Dict, Any
from datetime import datetime, timezone, timedelta
from pymongo import ReturnDocument

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from pywebpush import webpush, WebPushException

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_SECRET = os.environ.get('JWT_SECRET', 'avsgo-dev-secret')
JWT_ALG = 'HS256'
ADMIN_MOBILE = os.environ.get('ADMIN_MOBILE', '9365306642')
ADMIN_PASSWORD = os.environ['ADMIN_PASSWORD']
ADMIN_UPI = os.environ.get('ADMIN_UPI', '9365306642@ptsbi')
APP_NAME = 'avsgo'
VEHICLE_TYPES = ['E-Rickshaw', 'Tata Ace', 'Tempo', 'Tractor']
VAPID_SUBJECT = os.environ.get('VAPID_SUBJECT', 'mailto:admin@avsgo.app')
ROUTING_API_KEY = os.environ.get('ROUTING_API_KEY', '').strip()
ROUTING_PROVIDER = os.environ.get('ROUTING_PROVIDER', 'ors').strip().lower()
GOOGLE_MAPS_API_KEY = os.environ.get('GOOGLE_MAPS_API_KEY', '').strip()
ROAD_FACTOR = 1.35  # Haversine → road distance multiplier when no routing API is configured

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
background_tasks: list[asyncio.Task] = []


# ---------------- Realtime WebSocket ----------------
class BookingSocketManager:
    """Authenticated realtime channels for booking/trip updates.
    HTTP polling remains a safe fallback, but all live booking/location changes are
    also pushed here so customer/driver maps can update immediately.
    """
    def __init__(self):
        self.by_booking: Dict[str, set] = {}
        self.by_driver: Dict[str, set] = {}
        self.by_customer: Dict[str, set] = {}

    async def connect(self, ws: WebSocket, booking_id: str | None = None, driver_id: str | None = None, customer_mobile: str | None = None):
        await ws.accept()
        if booking_id:
            self.by_booking.setdefault(booking_id, set()).add(ws)
        if driver_id:
            self.by_driver.setdefault(driver_id, set()).add(ws)
        if customer_mobile:
            self.by_customer.setdefault(customer_mobile, set()).add(ws)

    def disconnect(self, ws: WebSocket, booking_id: str | None = None, driver_id: str | None = None, customer_mobile: str | None = None):
        groups = []
        if booking_id: groups.append((self.by_booking, booking_id))
        if driver_id: groups.append((self.by_driver, driver_id))
        if customer_mobile: groups.append((self.by_customer, customer_mobile))
        for store, key in groups:
            sockets = store.get(key)
            if sockets:
                sockets.discard(ws)
                if not sockets: store.pop(key, None)

    async def _send(self, sockets, payload):
        dead=[]
        for ws in list(sockets or []):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            sockets.discard(ws)

    async def booking_event(self, booking_id: str, event: str, data: dict | None = None):
        payload={'type': event, 'booking_id': booking_id, 'data': data or {}, 'server_time': now_iso()}
        sockets=set(self.by_booking.get(booking_id, set()))
        b=await db.bookings.find_one({'id': booking_id}, {'_id':0,'driver_id':1,'customer_mobile':1})
        if b:
            sockets |= set(self.by_driver.get(b.get('driver_id'), set())) if b.get('driver_id') else set()
            sockets |= set(self.by_customer.get(b.get('customer_mobile'), set())) if b.get('customer_mobile') else set()
        await self._send(sockets, payload)

    async def driver_event(self, driver_id: str, event: str, data: dict | None = None, booking_id: str | None = None):
        payload={'type': event, 'booking_id': booking_id, 'data': data or {}, 'server_time': now_iso()}
        await self._send(set(self.by_driver.get(driver_id, set())), payload)

    async def customer_event(self, mobile: str, event: str, data: dict | None = None, booking_id: str | None = None):
        payload={'type': event, 'booking_id': booking_id, 'data': data or {}, 'server_time': now_iso()}
        await self._send(set(self.by_customer.get(mobile, set())), payload)


ws_manager = BookingSocketManager()

# ---------------- Supabase Storage ----------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_STORAGE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_BUCKET = os.environ.get("SUPABASE_STORAGE_BUCKET", "avsgo files")


def _supabase_storage_url(path: str) -> str:
    from urllib.parse import quote
    safe_path = quote(path.lstrip("/"), safe="/")
    return f"{SUPABASE_URL}/storage/v1/object/{quote(SUPABASE_BUCKET, safe='')}/{safe_path}"


def put_object(path: str, data: bytes, content_type: str) -> dict:
    if not SUPABASE_URL or not SUPABASE_STORAGE_KEY:
        raise RuntimeError("Supabase Storage environment variables are missing")

    resp = requests.post(
        _supabase_storage_url(path),
        headers={
            "Authorization": f"Bearer {SUPABASE_STORAGE_KEY}",
            "apikey": SUPABASE_STORAGE_KEY,
            "Content-Type": content_type,
            "x-upsert": "true",
        },
        data=data,
        timeout=120,
    )

    resp.raise_for_status()
    
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            payload.setdefault("path", path)
            payload.setdefault("size", len(data))
            return payload
        return {"success": True, "path": path, "size": len(data)}
    except Exception:
        return {"success": True, "path": path, "size": len(data)}
    
    
       
def get_object(path: str):
    if not SUPABASE_URL or not SUPABASE_STORAGE_KEY:
        raise RuntimeError("Supabase Storage environment variables are missing")

    resp = requests.get(
        _supabase_storage_url(path),
        headers={
            "Authorization": f"Bearer {SUPABASE_STORAGE_KEY}",
            "apikey": SUPABASE_STORAGE_KEY,
        },
        timeout=60,
    )

    resp.raise_for_status()

    return resp.content, resp.headers.get(
        "Content-Type",
        "application/octet-stream"
    )

# ---------------- VAPID / Web Push ----------------
_vapid_priv_pem: Optional[str] = None
_vapid_pub_b64: Optional[str] = None


def _generate_vapid():
    priv = ec.generate_private_key(ec.SECP256R1())
    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    pub_bytes = priv.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    pub_b64 = base64.urlsafe_b64encode(pub_bytes).rstrip(b'=').decode()
    return pem, pub_b64


async def init_vapid():
    global _vapid_priv_pem, _vapid_pub_b64
    settings = await db.settings.find_one({'_id': 'vapid'})
    if settings and settings.get('private_pem') and settings.get('public_b64'):
        _vapid_priv_pem = settings['private_pem']
        _vapid_pub_b64 = settings['public_b64']
        return
    pem, pub = _generate_vapid()
    await db.settings.update_one(
        {'_id': 'vapid'},
        {'$set': {'private_pem': pem, 'public_b64': pub, 'created_at': datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    _vapid_priv_pem = pem
    _vapid_pub_b64 = pub
    logger.info('VAPID keys generated')


def _send_one(sub_info: dict, payload: dict):
    try:
        webpush(
            subscription_info=sub_info,
            data=json.dumps(payload),
            vapid_private_key=_vapid_priv_pem,
            vapid_claims={'sub': VAPID_SUBJECT},
            ttl=60 * 60 * 24,
        )
        return True, None
    except WebPushException as e:
        code = getattr(e.response, 'status_code', None) if getattr(e, 'response', None) is not None else None
        return False, code
    except Exception as e:
        logger.warning(f'webpush send error: {e}')
        return False, None


async def store_inapp(recipient_key: str, title: str, body: str, data: Optional[dict] = None):
    """Persist an in-app notification so users without Web Push can still see it via the bell."""
    if recipient_key != 'admin' and not recipient_key.startswith(('driver:', 'manager:')):
        return  # only track for authenticated roles
    try:
        await db.inapp_notifications.insert_one({
            'id': str(uuid.uuid4()),
            'recipient_key': recipient_key,
            'title': title,
            'body': body,
            'url': (data or {}).get('url'),
            'type': (data or {}).get('type'),
            'read': False,
            'created_at': now_iso(),
        })
    except Exception as e:
        logger.warning(f'inapp store failed: {e}')


async def send_push(subscriber_key: str, title: str, body: str, data: Optional[dict] = None):
    """Send a Web Push notification to every subscription associated with `subscriber_key`. Fire and forget safe.
    Also persists the notification for the in-app bell (drivers & admin)."""
    await store_inapp(subscriber_key, title, body, data)
    payload = {'title': title, 'body': body, 'data': data or {}}

    async def _run():
        cursor = db.push_subscriptions.find({'subscriber_key': subscriber_key})
        subs = await cursor.to_list(500)
        if not subs:
            return
        loop = asyncio.get_event_loop()
        for s in subs:
            ok, code = await loop.run_in_executor(None, _send_one, s['subscription'], payload)
            if not ok and code in (404, 410):
                await db.push_subscriptions.delete_one({'_id': s['_id']})

    asyncio.create_task(_run())


# ---------------- App ----------------
app = FastAPI(title="AvSGo API")
api_router = APIRouter(prefix="/api")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------- Models ----------------
class DriverRegister(BaseModel):
    name: str
    mobile: str
    pickup_pin: str
    password: Optional[str] = None


class CustomerRegister(BaseModel):
    name: str
    mobile: str
    pickup_pin: str


class AdminRegister(BaseModel):
    name: str
    mobile: str
    password: str


class DriverLogin(BaseModel):
    mobile: str
    password: str


class AdminLogin(BaseModel):
    mobile: str
    password: str


class ManagerCreate(BaseModel):
    name: str
    mobile: str
    manager_id: str
    password: str
    pickup_pins: List[str] = []
    permissions: Dict[str, List[str]] = {}
    commission_pct: float = 10.0
    active: bool = True


class ManagerLogin(BaseModel):
    manager_id: str
    password: str


class ManagerStatusUpdate(BaseModel):
    active: Optional[bool] = None
    resigned: Optional[bool] = None
    pickup_pins: Optional[List[str]] = None
    permissions: Optional[Dict[str, List[str]]] = None
    commission_pct: Optional[float] = None



class VehicleCreate(BaseModel):
    vehicle_type: str
    plate_no: str
    capacity: str
    rc_photo_id: Optional[str] = None
    vehicle_photo_id: Optional[str] = None


class VehicleAction(BaseModel):
    action: Literal['approve', 'reject']


class VehicleAvailability(BaseModel):
    available: bool


class FareUpdate(BaseModel):
    base_fare: float
    per_km: float
    commission_pct: float
class VehicleCategoryCreate(BaseModel):
    name: str
    capacity: str = ""
    enabled: bool = True

class VehicleCategoryUpdate(BaseModel):
    name: Optional[str] = None
    capacity: Optional[str] = None
    enabled: Optional[bool] = None 

class ManagerFareUpdate(BaseModel):
    base_fare: float
    per_km: float
    commission_pct: float

class DiscountUpdate(BaseModel):
    discount_pct: float = 0.0

class ComplaintCreate(BaseModel):
    subject: str
    message: str
    booking_id: Optional[str] = None

class ComplaintStatusUpdate(BaseModel):
    status: Literal['open','in_progress','resolved','closed']
    reply: Optional[str] = None


class BookingCreate(BaseModel):
    vehicle_id: str
    customer_name: str
    customer_mobile: str
    pickup: str
    drop_location: str
    distance_km: float
    pickup_lat: Optional[float] = None
    pickup_lng: Optional[float] = None
    drop_place_id: Optional[str] = None
    pickup_pin: Optional[str] = None


class BookingAutoCreate(BaseModel):
    vehicle_type: str
    customer_name: str
    customer_mobile: str
    pickup: str
    drop_location: str
    distance_km: float
    pickup_lat: float
    pickup_lng: float
    pickup_pin: str
    drop_place_id: Optional[str] = None
    max_radius_km: Optional[float] = 15

class ServiceAreaCreate(BaseModel):
    pickup_pin: str
    area_name: str
    latitude: float
    longitude: float
    enabled: bool = True

class ServiceAreaUpdate(BaseModel):
    area_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    enabled: Optional[bool] = None

class PaymentReceivedIn(BaseModel):
    payment_method: Literal['cash', 'upi', 'other'] = 'cash'


class DriverLocationIn(BaseModel):
    lat: float
    lng: float
    accuracy: Optional[float] = None


class CustomerLocationIn(BaseModel):
    customer_mobile: str
    lat: float
    lng: float
    accuracy: Optional[float] = None


class TripAction(BaseModel):
    action: Literal['start', 'reach_pickup', 'end']


class BookingAction(BaseModel):
    action: Literal['accept', 'reject', 'complete', 'cancel']


class NotifyDriver(BaseModel):
    driver_id: str
    message: Optional[str] = None


class PushSubscribeIn(BaseModel):
    subscriber_key: str
    subscription: Dict[str, Any]


# ---------------- Auth helpers ----------------
def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def check_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def make_token(sub: str, role: str) -> str:
    return pyjwt.encode({
        'sub': sub, 'role': role,
        'exp': datetime.now(timezone.utc) + timedelta(days=30),
    }, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> dict:
    return pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])


async def get_current(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401, 'Missing token')
    try:
        return decode_token(authorization.split(' ', 1)[1])
    except Exception:
        raise HTTPException(401, 'Invalid token')


async def get_optional(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith('Bearer '):
        return None
    try:
        return decode_token(authorization.split(' ', 1)[1])
    except Exception:
        return None


async def require_driver(user=Depends(get_current)):
    if user.get('role') != 'driver':
        raise HTTPException(403, 'Driver only')
    driver = await db.drivers.find_one({'id': user.get('sub'), 'active': True})
    if not driver:
        raise HTTPException(403, 'Driver is inactive')
    if not driver.get('approved', False):
        raise HTTPException(403, 'Driver approval is pending')
    return user

async def require_driver_vehicle(user=Depends(get_current)):
    if user.get('role') != 'driver':
        raise HTTPException(403, 'Driver only')

    driver = await db.drivers.find_one({
        'id': user.get('sub'),
        'active': True
    })

    if not driver:
        raise HTTPException(403, 'Driver is inactive')

    return user

async def require_admin(user=Depends(get_current)):
    if user.get('role') != 'admin':
        raise HTTPException(403, 'Admin only')
    return user
async def require_manager(user=Depends(get_current)):
    if user.get('role') != 'manager':
        raise HTTPException(403, 'Manager only')
    manager = await db.managers.find_one({'id': user.get('sub'), 'active': True, 'resigned': {'$ne': True}})
    if not manager:
        raise HTTPException(403, 'Manager is inactive or resigned')
    return manager


def manager_can(manager: dict, area: str, action: str) -> bool:
    perms = manager.get('permissions') or {}
    return action in (perms.get(area) or [])


def manager_pin_filter(manager: dict):
    pins = [str(x).strip() for x in (manager.get('pickup_pins') or []) if str(x).strip()]
    return pins


# ---------------- Background reliability workers ----------------
async def _broadcast_to_drivers(booking: dict, drivers: list[dict]):
    for d in drivers:
        km = round(float(d.get('distance_m', 0)) / 1000.0, 2)
        await send_push(
            f"driver:{d['id']}",
            'New booking request (near you)',
            f"{booking['customer_name']} • {booking['pickup']} → {booking['drop_location']} • {km} km away • ₹{booking['fare']} — first to accept wins",
            {'url': '/driver', 'type': 'new_booking', 'booking_id': booking['id']},
        )
        await ws_manager.driver_event(d['id'], 'new_booking', {
            'status': 'requested', 'vehicle_type': booking['vehicle_type'], 'customer_name': booking['customer_name'],
            'pickup': booking['pickup'], 'drop_location': booking['drop_location'], 'fare': booking['fare'],
            'distance_km': booking['distance_km'], 'request_expires_at': booking['request_expires_at'],
        }, booking_id=booking['id'])


async def _redispatch_one_expired(booking: dict):
    if booking.get('redispatch_count', 0) >= 5:
        await db.bookings.update_one({'id': booking['id'], 'status': 'requested', 'driver_id': None},
                                     {'$set': {'status': 'expired', 'trip_stage': 'expired', 'request_expired': True, 'request_expired_at': now_iso()}})
        await ws_manager.booking_event(booking['id'], 'booking_updated', {'status': 'expired'})
        return
    pickup_lat, pickup_lng = booking.get('pickup_lat'), booking.get('pickup_lng')
    if pickup_lat is None or pickup_lng is None:
        await db.bookings.update_one({'id': booking['id'], 'status': 'requested', 'driver_id': None},
                                     {'$set': {'status': 'expired', 'trip_stage': 'expired', 'request_expired': True, 'request_expired_at': now_iso()}})
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=LOCATION_FRESH_MIN)).isoformat()
    excluded = list(set((booking.get('broadcast_driver_ids') or []) + (booking.get('rejected_driver_ids') or [])))
    try:
        nearby = await db.drivers.aggregate([
            {'$geoNear': {
                'near': {'type': 'Point', 'coordinates': [pickup_lng, pickup_lat]},
                'distanceField': 'distance_m', 'maxDistance': int(float(booking.get('max_radius_km') or 25) * 1000),
                'spherical': True,
                'query': {'location_updated_at': {'$gte': cutoff}, 'approved': True, 'active': True, 'online': True,
                          'id': {'$nin': excluded}},
            }},
            {'$project': {'_id': 0, 'id': 1, 'name': 1, 'mobile': 1, 'distance_m': 1}},
            {'$limit': 50},
        ]).to_list(50)
        driver_ids = [d['id'] for d in nearby]
        vehicles = await db.vehicles.find({'owner_id': {'$in': driver_ids}, 'status': 'approved',
                                           'available': {'$ne': False}, 'vehicle_type': booking['vehicle_type']}, {'_id': 0}).to_list(200)
        owners = {v['owner_id'] for v in vehicles}
        eligible = [d for d in nearby if d['id'] in owners]
    except Exception as e:
        logger.warning('redispatch lookup failed: %s', e)
        return
    if not eligible:
        await db.bookings.update_one({'id': booking['id'], 'status': 'requested', 'driver_id': None},
                                     {'$set': {'status': 'expired', 'trip_stage': 'expired', 'request_expired': True, 'request_expired_at': now_iso()}})
        await send_push(f"customer:{booking['customer_mobile']}", 'No driver available',
                        f"No {booking['vehicle_type']} driver accepted your booking. Please try again.",
                        {'url': '/customer', 'type': 'booking_expired', 'booking_id': booking['id']})
        await ws_manager.booking_event(booking['id'], 'booking_updated', {'status': 'expired'})
        return
    new_expiry = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()
    new_ids = [d['id'] for d in eligible]
    updated = await db.bookings.find_one_and_update(
        {'id': booking['id'], 'status': 'requested', 'driver_id': None},
        {'$set': {'request_expires_at': new_expiry, 'request_expired': False,
                  'trip_stage': 'driver_to_pickup', 'redispatch_count': int(booking.get('redispatch_count', 0)) + 1},
         '$addToSet': {'broadcast_driver_ids': {'$each': new_ids}}},
        projection={'_id': 0}, return_document=ReturnDocument.AFTER,
    )
    if updated:
        await _broadcast_to_drivers(updated, eligible)
        await ws_manager.booking_event(booking['id'], 'booking_redispatched', {
            'status': 'requested', 'request_expires_at': new_expiry, 'driver_count': len(eligible)
        })


async def booking_redispatch_worker():
    while True:
        try:
            now = datetime.now(timezone.utc).isoformat()
            expired = await db.bookings.find({'status': 'requested', 'driver_id': None,
                                              'request_expires_at': {'$lte': now}}, {'_id': 0}).to_list(50)
            for b in expired:
                await _redispatch_one_expired(b)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning('booking redispatch worker error: %s', e)
        await asyncio.sleep(2)


async def driver_presence_worker():
    while True:
        try:
            cutoff = (datetime.now(timezone.utc) - timedelta(seconds=90)).isoformat()
            await db.drivers.update_many({'online': True, 'online_updated_at': {'$lt': cutoff}},
                                         {'$set': {'online': False, 'offline_reason': 'heartbeat_timeout'}})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning('driver presence worker error: %s', e)
        await asyncio.sleep(15)


# ---------------- Startup ----------------
@app.on_event("startup")
async def startup():
    
    try:
        await init_vapid()
    except Exception as e:
        logger.error(f"VAPID init failed: {e}")

    # Seed default fare settings
    for vt in VEHICLE_TYPES:
        existing = await db.fare_settings.find_one({'vehicle_type': vt})
        if not existing:
            defaults = {
                'E-Rickshaw': {'base_fare': 30, 'per_km': 10, 'commission_pct': 10},
                'Tata Ace': {'base_fare': 100, 'per_km': 18, 'commission_pct': 12},
                'Tempo': {'base_fare': 150, 'per_km': 22, 'commission_pct': 12},
                'Tractor': {'base_fare': 200, 'per_km': 25, 'commission_pct': 15},
            }[vt]
            await db.fare_settings.insert_one({
                'id': str(uuid.uuid4()),
                'vehicle_type': vt,
                **defaults,
                'updated_at': now_iso(),
            })

    if not await db.drivers.find_one({'mobile': '9000000001'}):
        await db.drivers.insert_one({
            'id': str(uuid.uuid4()),
            'name': 'Test Driver',
            'mobile': '9000000001',
            'password_hash': hash_pw('Driver@123'),
            'created_at': now_iso(),
        })

    # Backfill: any existing vehicle without the `available` flag is treated as Available.
    await db.vehicles.update_many(
        {'available': {'$exists': False}},
        {'$set': {'available': True}},
    )

    # Geo index for nearest-driver matching
    try:
        await db.drivers.create_index([("location", "2dsphere")])
    except Exception as e:
        logger.warning(f"2dsphere index failed: {e}")

    background_tasks.extend([asyncio.create_task(booking_redispatch_worker()), asyncio.create_task(driver_presence_worker())])


@app.on_event("shutdown")
async def shutdown_db_client():
    for task in background_tasks:
        task.cancel()
    if background_tasks:
        await asyncio.gather(*background_tasks, return_exceptions=True)
    client.close()


# ---------------- WebSocket Routes ----------------
@app.websocket('/api/ws/driver')
async def driver_websocket(ws: WebSocket, token: str = Query(...)):
    driver_id = None
    try:
        user = decode_token(token)
        if user.get('role') != 'driver':
            await ws.close(code=1008); return
        driver = await db.drivers.find_one({'id': user.get('sub'), 'active': True, 'approved': True}, {'_id':0,'id':1})
        if not driver:
            await ws.close(code=1008); return
        driver_id = user['sub']
        await ws_manager.connect(ws, driver_id=driver_id)
        await ws.send_json({'type':'connected','server_time':now_iso()})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.info('driver websocket closed: %s', e)
    finally:
        if driver_id: ws_manager.disconnect(ws, driver_id=driver_id)


@app.websocket('/api/ws/customer')
async def customer_websocket(ws: WebSocket, booking_id: str = Query(...), mobile: str = Query(...)):
    mobile = mobile.strip()
    try:
        b = await db.bookings.find_one({'id': booking_id, 'customer_mobile': mobile}, {'_id':0,'id':1})
        if not b:
            await ws.close(code=1008); return
        await ws_manager.connect(ws, booking_id=booking_id, customer_mobile=mobile)
        await ws.send_json({'type':'connected','booking_id':booking_id,'server_time':now_iso()})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.info('customer websocket closed: %s', e)
    finally:
        ws_manager.disconnect(ws, booking_id=booking_id, customer_mobile=mobile)


# ---------------- Routes ----------------
@api_router.get("/")
async def root():
    return {"app": "AvSGo", "status": "ok"}


# ---- Auth ----
@api_router.post("/customer/register")
async def customer_register(payload: CustomerRegister):
    mobile = payload.mobile.strip()
    name = payload.name.strip()
    if len(mobile) != 10 or not mobile.isdigit():
        raise HTTPException(400, 'Enter a valid 10-digit mobile number')
    if not name:
        raise HTTPException(400, 'Customer name is required')
    area = await validate_pickup_pin(payload.pickup_pin)
    doc = {
        'name': name,
        'mobile': mobile,
        'pickup_pin': area['pickup_pin'],
        'active': True,
        'updated_at': now_iso(),
    }
    await db.customers.update_one({'mobile': mobile}, {'$set': doc, '$setOnInsert': {'id': str(uuid.uuid4()), 'created_at': now_iso()}}, upsert=True)
    saved = await db.customers.find_one({'mobile': mobile}, {'_id': 0})
    return saved


@api_router.post("/auth/driver/register")
async def driver_register(payload: DriverRegister):
    mobile = payload.mobile.strip()
    pickup_pin = payload.pickup_pin.strip() if getattr(payload, 'pickup_pin', None) else ''
    if len(mobile) != 10 or not mobile.isdigit():
        raise HTTPException(400, 'Enter a valid 10-digit mobile number')
    # Driver dispatch is NOT restricted by Pickup PIN. PIN is optional metadata for manager/service-area association.
    if pickup_pin:
        await validate_pickup_pin(pickup_pin)
    if await db.drivers.find_one({'mobile': mobile}):
        raise HTTPException(400, 'Mobile already registered')
    doc = {
        'id': str(uuid.uuid4()),
        'name': payload.name.strip(),
        'mobile': mobile,
        'pickup_pin': pickup_pin,
        'password_hash': hash_pw(payload.password or uuid.uuid4().hex),
        'approved': False,
        'active': True,
        'online': False,
        'created_at': now_iso(),
    }
    await db.drivers.insert_one(doc)
    token = make_token(doc['id'], 'driver')
    await send_push('admin', 'New driver registered', f"{doc['name']} ({doc['mobile']}) registered on AvSGo.", {'url': '/admin', 'type': 'driver_registered'})
    return {'token': token, 'driver': {'id': doc['id'], 'name': doc['name'], 'mobile': doc['mobile'], 'pickup_pin': pickup_pin, 'approved': False}}


@api_router.post("/auth/driver/login")
async def driver_login_disabled(payload: DriverLogin):
    raise HTTPException(410, 'Driver login is disabled. Register the driver on this device.')


@api_router.get("/auth/admin/status")
async def admin_status():
    rec = await db.admins.find_one({'active': True})
    return {'registered': bool(rec), 'mobile': rec.get('mobile') if rec else None}


@api_router.post("/auth/admin/register")
async def admin_register(payload: AdminRegister):
    mobile = payload.mobile.strip()
    if len(mobile) != 10 or not mobile.isdigit():
        raise HTTPException(400, 'Enter a valid 10-digit mobile number')
    if len(payload.password) < 6:
        raise HTTPException(400, 'Password must be at least 6 characters')
    existing = await db.admins.find_one({'active': True})
    if existing:
        raise HTTPException(409, 'Admin is already registered. Please login.')
    doc = {'id': str(uuid.uuid4()), 'name': payload.name.strip(), 'mobile': mobile, 'password_hash': hash_pw(payload.password), 'active': True, 'created_at': now_iso()}
    await db.admins.insert_one(doc)
    return {'token': make_token(doc['id'], 'admin'), 'admin': {'id': doc['id'], 'name': doc['name'], 'mobile': doc['mobile'], 'upi': ADMIN_UPI}}


@api_router.post("/auth/admin/login")
async def admin_login(payload: AdminLogin):
    admin = await db.admins.find_one({'mobile': payload.mobile.strip(), 'active': True})
    if admin:
        if not check_pw(payload.password, admin.get('password_hash', '')):
            raise HTTPException(401, 'Invalid mobile or password')
        return {'token': make_token(admin['id'], 'admin'), 'admin': {'id': admin['id'], 'name': admin.get('name'), 'mobile': admin['mobile'], 'upi': ADMIN_UPI}}
    # Legacy env-admin fallback; existing deployments keep working until the first registration is created.
    if payload.mobile.strip() == ADMIN_MOBILE and payload.password == ADMIN_PASSWORD:
        return {'token': make_token('admin', 'admin'), 'admin': {'mobile': ADMIN_MOBILE, 'upi': ADMIN_UPI}}
    raise HTTPException(401, 'Invalid mobile or password')


# ---- Service Areas (Pickup PIN) ----
@api_router.get("/service-areas")
async def public_service_areas():
    cur = db.service_areas.find({'enabled': True}, {'_id': 0}).sort('area_name', 1)
    return await cur.to_list(5000)

@api_router.get("/admin/service-areas")
async def admin_service_areas(_=Depends(require_admin)):
    cur = db.service_areas.find({}, {'_id': 0}).sort('area_name', 1)
    return await cur.to_list(5000)

@api_router.post("/admin/service-areas")
async def admin_add_service_area(payload: ServiceAreaCreate, _=Depends(require_admin)):
    pin = payload.pickup_pin.strip()
    if not (pin.isdigit() and len(pin) == 6):
        raise HTTPException(400, 'Pickup PIN must be a valid 6-digit PIN')
    if not payload.area_name.strip():
        raise HTTPException(400, 'Area name is required')
    doc = {'id': str(uuid.uuid4()), 'pickup_pin': pin, 'area_name': payload.area_name.strip(),
           'latitude': payload.latitude, 'longitude': payload.longitude, 'enabled': payload.enabled,
           'created_at': now_iso(), 'updated_at': now_iso()}
    await db.service_areas.update_one({'pickup_pin': pin}, {'$set': doc}, upsert=True)
    doc.pop('_id', None)
    return doc

@api_router.patch("/admin/service-areas/{area_id}")
async def admin_update_service_area(area_id: str, payload: ServiceAreaUpdate, _=Depends(require_admin)):
    update = {k:v for k,v in payload.model_dump().items() if v is not None}
    if 'area_name' in update: update['area_name'] = update['area_name'].strip()
    if not update: raise HTTPException(400, 'Nothing to update')
    update['updated_at'] = now_iso()
    r = await db.service_areas.update_one({'id': area_id}, {'$set': update})
    if not r.matched_count: raise HTTPException(404, 'Service area not found')
    return await db.service_areas.find_one({'id': area_id}, {'_id': 0})

# ---- Manager Auth / Administration ----
@api_router.post("/admin/managers")
async def admin_create_manager(payload: ManagerCreate, _=Depends(require_admin)):
    name = payload.name.strip()
    mobile = payload.mobile.strip()
    manager_id = payload.manager_id.strip()
    if not name or not manager_id:
        raise HTTPException(400, 'Manager name and Manager ID are required')
    if len(mobile) != 10 or not mobile.isdigit():
        raise HTTPException(400, 'Enter a valid 10-digit mobile number')
    if len(payload.password) < 6:
        raise HTTPException(400, 'Password must be at least 6 characters')
    if not 0 <= payload.commission_pct <= 100:
        raise HTTPException(400, 'Commission must be between 0 and 100')
    if await db.managers.find_one({'$or': [{'manager_id': manager_id}, {'mobile': mobile}]}):
        raise HTTPException(409, 'Manager ID or mobile already exists')
    perms = payload.permissions or {
        'customers': ['view'], 'drivers': ['view'], 'vehicles': ['view'],
        'drop_places': [], 'bookings': ['view'], 'commission': ['view'],
        'payments': ['view'], 'fares': ['view'], 'complaints': ['view'], 'reports': ['view'],
    }
    doc = {
        'id': str(uuid.uuid4()), 'name': name, 'mobile': mobile, 'manager_id': manager_id,
        'password_hash': hash_pw(payload.password), 'pickup_pins': sorted(set(payload.pickup_pins or [])),
        'permissions': perms, 'commission_pct': float(payload.commission_pct),
        'active': bool(payload.active), 'resigned': False, 'created_at': now_iso(), 'updated_at': now_iso(),
    }
    await db.managers.insert_one(doc)
    safe = {k:v for k,v in doc.items() if k not in ('_id','password_hash')}
    return safe


@api_router.get("/admin/managers")
async def admin_list_managers(_=Depends(require_admin)):
    cur = db.managers.find({}, {'_id': 0, 'password_hash': 0}).sort('created_at', -1)
    return await cur.to_list(500)


@api_router.patch("/admin/managers/{manager_id}")
async def admin_update_manager(manager_id: str, payload: ManagerStatusUpdate, _=Depends(require_admin)):
    manager = await db.managers.find_one({'id': manager_id})
    if not manager:
        raise HTTPException(404, 'Manager not found')
    update = {}
    if payload.active is not None: update['active'] = payload.active
    if payload.resigned is not None:
        update['resigned'] = payload.resigned
        if payload.resigned: update['active'] = False
    if payload.pickup_pins is not None: update['pickup_pins'] = sorted(set(payload.pickup_pins))
    if payload.permissions is not None: update['permissions'] = payload.permissions
    if payload.commission_pct is not None:
        if not 0 <= payload.commission_pct <= 100: raise HTTPException(400, 'Commission must be between 0 and 100')
        update['commission_pct'] = float(payload.commission_pct)
    if not update: raise HTTPException(400, 'Nothing to update')
    update['updated_at'] = now_iso()
    await db.managers.update_one({'id': manager_id}, {'$set': update})
    return await db.managers.find_one({'id': manager_id}, {'_id': 0, 'password_hash': 0})


@api_router.post("/auth/manager/login")
async def manager_login(payload: ManagerLogin):
    manager = await db.managers.find_one({'manager_id': payload.manager_id.strip(), 'active': True, 'resigned': {'$ne': True}})
    if not manager or not check_pw(payload.password, manager.get('password_hash', '')):
        raise HTTPException(401, 'Invalid Manager ID or password')
    return {
        'token': make_token(manager['id'], 'manager'),
        'manager': {k: v for k, v in manager.items() if k not in ('_id','password_hash')},
    }


@api_router.get("/manager/me")
async def manager_me(manager=Depends(require_manager)):
    return {k:v for k,v in manager.items() if k not in ('_id','password_hash')}


@api_router.get("/manager/drop-places")
async def manager_drop_places(manager=Depends(require_manager)):
    if not manager_can(manager, 'drop_places', 'view') and not manager_can(manager, 'drop_places', 'add') and not manager_can(manager, 'drop_places', 'edit'):
        raise HTTPException(403, 'Drop Place permission required')
    # Drop places remain globally selectable; manager access is scoped by the PINs they administer.
    pins = manager_pin_filter(manager)
    q = {'enabled': True}
    if pins:
        q['$or'] = [{'pickup_pin': {'$in': pins}}, {'pickup_pin': None}]
    cur = db.drop_places.find(q, {'_id': 0}).sort('place_name', 1)
    return await cur.to_list(10000)
class DropPlaceCreate(BaseModel):
    place_name: str
    latitude: float
    longitude: float
    pickup_pin: Optional[str] = None
    enabled: bool = True


class DropPlaceAction(BaseModel):
    enabled: Optional[bool] = None
    place_name: Optional[str] = None
    


@api_router.post("/manager/drop-places")
async def manager_add_drop_place(payload: DropPlaceCreate, manager=Depends(require_manager)):
    if not manager_can(manager, 'drop_places', 'add'):
        raise HTTPException(403, 'Add Place permission is OFF')
    name = payload.place_name.strip()
    if not name: raise HTTPException(400, 'Place name is required')
    pins = manager_pin_filter(manager)
    if not pins: raise HTTPException(400, 'Assign at least one Pickup PIN to this manager')
    # A manager-created place is attached to the first assigned service PIN for manager scope.
    pin = payload.pickup_pin.strip() if payload.pickup_pin else pins[0]
    if pin not in pins: raise HTTPException(403, 'Pickup PIN is not assigned to this manager')
    doc = {'id': str(uuid.uuid4()), 'place_name': name, 'latitude': payload.latitude, 'longitude': payload.longitude,
           'pickup_pin': pin, 'enabled': payload.enabled, 'added_by_type': 'manager', 'added_by_id': manager['id'],
           'added_by_name': manager.get('name'), 'created_at': now_iso(), 'updated_at': now_iso()}
    await db.drop_places.insert_one(doc)
    doc.pop('_id', None)
    return doc


@api_router.patch("/manager/drop-places/{place_id}")
async def manager_update_drop_place(place_id: str, payload: DropPlaceAction, manager=Depends(require_manager)):
    if payload.place_name is not None and not manager_can(manager, 'drop_places', 'edit'):
        raise HTTPException(403, 'Edit Place permission is OFF')
    if payload.enabled is not None and not manager_can(manager, 'drop_places', 'enable_disable'):
        raise HTTPException(403, 'Enable/Disable permission is OFF')
    place = await db.drop_places.find_one({'id': place_id})
    if not place:
        raise HTTPException(404, 'Drop place not found')
    pins = manager_pin_filter(manager)
    if place.get('pickup_pin') and place.get('pickup_pin') not in pins:
        raise HTTPException(403, 'This Drop Place is outside your assigned Pickup PIN')
    update = {}
    if payload.place_name is not None:
        name = payload.place_name.strip()
        if not name: raise HTTPException(400, 'Place name is required')
        update['place_name'] = name
    if payload.enabled is not None: update['enabled'] = payload.enabled
    if not update: raise HTTPException(400, 'Nothing to update')
    update['updated_at'] = now_iso(); update['updated_by_type'] = 'manager'; update['updated_by_id'] = manager['id']
    await db.drop_places.update_one({'id': place_id}, {'$set': update})
    return await db.drop_places.find_one({'id': place_id}, {'_id': 0})


@api_router.get("/manager/bookings")
async def manager_bookings(manager=Depends(require_manager)):
    if not manager_can(manager, 'bookings', 'view'):
        raise HTTPException(403, 'Bookings view permission is OFF')
    pins = manager_pin_filter(manager)
    q = {'pickup_pin': {'$in': pins}} if pins else {'pickup_pin': '__none__'}
    return await db.bookings.find(q, {'_id': 0}).sort('created_at', -1).to_list(1000)


@api_router.get("/manager/customers")
async def manager_customers(manager=Depends(require_manager)):
    if not manager_can(manager, 'customers', 'view'):
        raise HTTPException(403, 'Customers view permission is OFF')
    pins = manager_pin_filter(manager)
    q = {'pickup_pin': {'$in': pins}} if pins else {'pickup_pin': '__none__'}
    return await db.customers.find(q, {'_id': 0}).sort('created_at', -1).to_list(1000)


@api_router.get("/manager/drivers")
async def manager_drivers(manager=Depends(require_manager)):
    if not manager_can(manager, 'drivers', 'view'):
        raise HTTPException(403, 'Drivers view permission is OFF')
    # Manager access is restricted to drivers registered under the manager's assigned Pickup PIN(s).
    pins = [str(p).strip() for p in (manager.get('pickup_pins') or []) if str(p).strip()]
    if not pins:
        return []
    return await db.drivers.find({'pickup_pin': {'$in': pins}}, {'_id': 0, 'password_hash': 0}).sort('created_at', -1).to_list(1000)


@api_router.patch("/manager/drivers/{driver_id}/approval")
async def manager_driver_approval(driver_id: str, payload: VehicleAction, manager=Depends(require_manager)):
    if not manager_can(manager, 'drivers', 'approve_reject'):
        raise HTTPException(403, 'Driver approval permission is OFF')
    driver = await db.drivers.find_one({'id': driver_id})
    if not driver: raise HTTPException(404, 'Driver not found')
    if str(driver.get('pickup_pin') or '') not in [str(p).strip() for p in (manager.get('pickup_pins') or [])]:
        raise HTTPException(403, 'Driver is outside your assigned Pickup PIN area')
    approved = payload.action == 'approve'
    await db.drivers.update_one({'id': driver_id}, {'$set': {'approved': approved, 'active': approved, 'reviewed_by_manager': manager['id'], 'reviewed_at': now_iso()}})
    return await db.drivers.find_one({'id': driver_id}, {'_id': 0, 'password_hash': 0})


@api_router.patch("/manager/vehicles/{vehicle_id}/approval")
async def manager_vehicle_approval(vehicle_id: str, payload: VehicleAction, manager=Depends(require_manager)):
    if not manager_can(manager, 'vehicles', 'approve_reject'):
        raise HTTPException(403, 'Vehicle approval permission is OFF')
    vehicle = await db.vehicles.find_one({'id': vehicle_id})
    if not vehicle: raise HTTPException(404, 'Vehicle not found')
    new_status = 'approved' if payload.action == 'approve' else 'rejected'
    await db.vehicles.update_one({'id': vehicle_id}, {'$set': {'status': new_status, 'reviewed_by_manager': manager['id'], 'reviewed_at': now_iso()}})
    return await db.vehicles.find_one({'id': vehicle_id}, {'_id': 0})


@api_router.get("/manager/vehicles")
async def manager_vehicles(manager=Depends(require_manager)):
    if not manager_can(manager, 'vehicles', 'view'):
        raise HTTPException(403, 'Vehicles view permission is OFF')
    return await db.vehicles.find({}, {'_id': 0}).sort('created_at', -1).to_list(1000)


@api_router.get("/manager/commission")
async def manager_commission(manager=Depends(require_manager)):
    if not manager_can(manager, 'commission', 'view'):
        raise HTTPException(403, 'Commission view permission is OFF')
    # Earnings are calculated from completed bookings assigned to the manager's pickup areas.
    pins = manager_pin_filter(manager)
    q = {'pickup_pin': {'$in': pins}, 'status': 'completed'} if pins else {'pickup_pin': '__none__'}
    bookings = await db.bookings.find(q, {'_id': 0, 'commission': 1, 'fare': 1}).to_list(5000)
    admin_commission = round(sum(float(b.get('commission') or 0) for b in bookings), 2)
    earned = round(admin_commission * float(manager.get('commission_pct', 10)) / 100, 2)
    paid = await db.manager_payouts.aggregate([
        {'$match': {'manager_id': manager['id'], 'status': 'completed'}},
        {'$group': {'_id': None, 'total': {'$sum': '$amount'}}}
    ]).to_list(1)
    paid_total = round(float(paid[0]['total']) if paid else 0, 2)
    return {'admin_commission': admin_commission, 'commission_pct': manager.get('commission_pct', 10), 'earnings': earned, 'paid': paid_total, 'remaining': round(max(0, earned-paid_total),2)}


# ---- File upload ----
@api_router.post("/upload")
async def upload(file: UploadFile = File(...)):
    ext = (file.filename or 'bin').split('.')[-1].lower()
    if ext not in ('jpg', 'jpeg', 'png', 'webp', 'pdf'):
        raise HTTPException(400, 'Only jpg/png/webp/pdf files allowed') 
    file_id = str(uuid.uuid4())
    path = f"{APP_NAME}/uploads/{file_id}.{ext}"
    data = await file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(400, 'File too large (max 5MB)')
    ct = file.content_type or 'image/jpeg'
    result = put_object(path, data, ct)
    doc = {
        'id': file_id,
        'storage_path': result['path'],
        'original_filename': file.filename,
        'content_type': ct,
        'size': result.get('size', len(data)),
        'is_deleted': False,
        'created_at': now_iso(),
    }
    await db.files.insert_one(doc)
    return {'id': file_id, 'url': f"/api/files/{file_id}"}


@api_router.get("/files/{file_id}")
async def download_file(file_id: str):
    rec = await db.files.find_one({'id': file_id, 'is_deleted': False})
    if not rec:
        raise HTTPException(404, 'File not found')
    data, ct = get_object(rec['storage_path'])
    return Response(content=data, media_type=rec.get('content_type', ct))


# ---- Push ----
@api_router.get("/push/public-key")
async def push_public_key():
    return {'public_key': _vapid_pub_b64}


@api_router.post("/push/subscribe")
async def push_subscribe(payload: PushSubscribeIn, user=Depends(get_optional)):
    key = payload.subscriber_key.strip()
    # Enforce role match when a token is provided
    if key == 'admin' and (not user or user.get('role') != 'admin'):
        raise HTTPException(403, 'Admin auth required')
    if key.startswith('driver:'):
        if not user or user.get('role') != 'driver' or key != f"driver:{user['sub']}":
            raise HTTPException(403, 'Driver auth required')
    if key.startswith('manager:'):
        if not user or user.get('role') != 'manager' or key != f"manager:{user['sub']}":
            raise HTTPException(403, 'Manager auth required')
    if not key.startswith(('admin', 'driver:', 'manager:', 'customer:')):
        raise HTTPException(400, 'Invalid subscriber_key')

    endpoint = payload.subscription.get('endpoint')
    if not endpoint:
        raise HTTPException(400, 'Invalid subscription')
    await db.push_subscriptions.update_one(
        {'subscriber_key': key, 'endpoint': endpoint},
        {'$set': {
            'subscriber_key': key,
            'endpoint': endpoint,
            'subscription': payload.subscription,
            'updated_at': now_iso(),
        }},
        upsert=True,
    )
    return {'ok': True}


# ---- Fare/discount helpers ----
async def resolve_manager_for_pin(pickup_pin: str | None):
    if not pickup_pin:
        return None
    return await db.managers.find_one({'pickup_pins': pickup_pin, 'active': True, 'resigned': {'$ne': True}}, {'_id': 0})

async def resolve_fare(vehicle_type: str, pickup_pin: str | None):
    manager = await resolve_manager_for_pin(pickup_pin)
    if manager:
        mf = await db.manager_fare_settings.find_one({'manager_id': manager['id'], 'vehicle_type': vehicle_type}, {'_id': 0})
        if mf:
            return mf, manager
    fs = await db.fare_settings.find_one({'vehicle_type': vehicle_type}, {'_id': 0})
    return fs, manager

async def resolve_discount(pickup_pin: str | None):
    manager = await resolve_manager_for_pin(pickup_pin)
    if not manager:
        return 0.0, None
    d = await db.manager_discounts.find_one({'manager_id': manager['id']}, {'_id': 0})
    return max(0.0, min(100.0, float((d or {}).get('discount_pct', 0)))), manager
    
# ---- Vehicle Categories ----
@api_router.get("/vehicle-categories")
async def list_vehicle_categories():
    cur = db.vehicle_categories.find(
        {"enabled": True},
        {"_id": 0}
    ).sort("name", 1)
    return await cur.to_list(200)


@api_router.post("/admin/vehicle-categories")
async def create_vehicle_category(
    payload: VehicleCategoryCreate,
    _=Depends(require_admin)
):
    name = payload.name.strip()

    if not name:
        raise HTTPException(400, "Vehicle category name is required")

    existing = await db.vehicle_categories.find_one({
        "name": {"$regex": f"^{name}$", "$options": "i"}
    })

    if existing:
        raise HTTPException(409, "Vehicle category already exists")

    category = {
        "id": str(uuid.uuid4()),
        "name": name,
        "capacity": payload.capacity.strip(),
        "enabled": payload.enabled,
        "created_at": now_iso(),
    }

    await db.vehicle_categories.insert_one(category)

    await db.fare_settings.update_one(
        {"vehicle_type": name},
        {
            "$setOnInsert": {
                "id": str(uuid.uuid4()),
                "vehicle_type": name,
                "base_fare": 0,
                "per_km": 0,
                "commission_pct": 0,
                "updated_at": now_iso(),
            }
        },
        upsert=True,
    )

    category.pop("_id", None)
    return category
# ---- Fare settings ----
@api_router.get("/fare-settings")
async def list_fares():
    cur = db.fare_settings.find({}, {'_id': 0})
    return await cur.to_list(100)


@api_router.put("/admin/fare-settings/{vehicle_type}")
async def update_fare(vehicle_type: str, payload: FareUpdate, _=Depends(require_admin)):
    if vehicle_type not in VEHICLE_TYPES and not await db.vehicle_categories.find_one(
        {"name": vehicle_type, "enabled": True}
):
        raise HTTPException(400, 'Invalid vehicle type')
    await db.fare_settings.update_one(
        {'vehicle_type': vehicle_type},
        {'$set': {
            'base_fare': payload.base_fare,
            'per_km': payload.per_km,
            'commission_pct': payload.commission_pct,
            'updated_at': now_iso(),
        }},
        upsert=True,
    )
    fs = await db.fare_settings.find_one({'vehicle_type': vehicle_type}, {'_id': 0})
    return fs


@api_router.get('/admin/manager-fare-settings/{manager_id}')
async def admin_manager_fares(manager_id: str, _=Depends(require_admin)):
    return await db.manager_fare_settings.find({'manager_id': manager_id}, {'_id': 0}).to_list(100)

@api_router.put('/admin/manager-fare-settings/{manager_id}/{vehicle_type}')
async def admin_update_manager_fare(manager_id: str, vehicle_type: str, payload: ManagerFareUpdate, _=Depends(require_admin)):
    if vehicle_type not in VEHICLE_TYPES and not await db.vehicle_categories.find_one(
        {"name": vehicle_type, "enabled": True}
):
        raise HTTPException(400, "Invalid vehicle type")
    if not 0 <= payload.commission_pct <= 100: raise HTTPException(400, 'Commission must be between 0 and 100')
    doc={'manager_id':manager_id,'vehicle_type':vehicle_type,'base_fare':payload.base_fare,'per_km':payload.per_km,'commission_pct':payload.commission_pct,'updated_at':now_iso()}
    await db.manager_fare_settings.update_one({'manager_id':manager_id,'vehicle_type':vehicle_type},{'$set':doc},upsert=True)
    return doc

@api_router.get('/manager/fare-settings')
async def manager_fares(manager=Depends(require_manager)):
    if not manager_can(manager, 'fares', 'manage') and not manager_can(manager, 'commission', 'manage'):
        raise HTTPException(403, 'Fare permission is OFF')
    return await db.manager_fare_settings.find({'manager_id':manager['id']},{'_id':0}).to_list(100)

@api_router.put('/manager/fare-settings/{vehicle_type}')
async def manager_update_fare(vehicle_type: str, payload: ManagerFareUpdate, manager=Depends(require_manager)):
    if not manager_can(manager, 'fares', 'manage'):
        raise HTTPException(403, 'Fare permission is OFF')
    if vehicle_type not in VEHICLE_TYPES and not await db.vehicle_categories.find_one(
         {"name": vehicle_type, "enabled": True}
):
         raise HTTPException(400, "Invalid vehicle type")  
    doc={'manager_id':manager['id'],'vehicle_type':vehicle_type,'base_fare':payload.base_fare,'per_km':payload.per_km,'commission_pct':payload.commission_pct,'updated_at':now_iso()}
    await db.manager_fare_settings.update_one({'manager_id':manager['id'],'vehicle_type':vehicle_type},{'$set':doc},upsert=True)
    return doc

@api_router.get('/admin/manager-discounts/{manager_id}')
async def admin_get_discount(manager_id: str, _=Depends(require_admin)):
    return await db.manager_discounts.find_one({'manager_id':manager_id},{'_id':0}) or {'manager_id':manager_id,'discount_pct':0}

@api_router.put('/admin/manager-discounts/{manager_id}')
async def admin_set_discount(manager_id: str, payload: DiscountUpdate, _=Depends(require_admin)):
    if not 0 <= payload.discount_pct <= 100: raise HTTPException(400,'Discount must be between 0 and 100')
    doc={'manager_id':manager_id,'discount_pct':payload.discount_pct,'updated_at':now_iso()}
    await db.manager_discounts.update_one({'manager_id':manager_id},{'$set':doc},upsert=True)
    return doc

@api_router.post('/customer/complaints')
async def customer_create_complaint(payload: ComplaintCreate, mobile: str = Query(...)):
    if not payload.subject.strip() or not payload.message.strip(): raise HTTPException(400,'Subject and message are required')
    b=None
    if payload.booking_id:
        b=await db.bookings.find_one({'id':payload.booking_id,'customer_mobile':mobile.strip()},{'_id':0,'pickup_pin':1})
        if not b: raise HTTPException(404,'Booking not found')
    doc={'id':str(uuid.uuid4()),'role':'customer','owner_id':mobile.strip(),'booking_id':payload.booking_id,'pickup_pin':b.get('pickup_pin') if b else None,'subject':payload.subject.strip(),'message':payload.message.strip(),'status':'open','created_at':now_iso(),'updated_at':now_iso()}
    await db.complaints.insert_one(doc); doc.pop('_id',None)
    return doc

@api_router.get('/admin/complaints')
async def admin_complaints(_=Depends(require_admin)):
    return await db.complaints.find({}, {'_id':0}).sort('created_at',-1).to_list(2000)

@api_router.patch('/admin/complaints/{complaint_id}')
async def admin_update_complaint(complaint_id: str, payload: ComplaintStatusUpdate, _=Depends(require_admin)):
    update={'status':payload.status,'updated_at':now_iso()}
    if payload.reply is not None: update['admin_reply']=payload.reply
    r=await db.complaints.update_one({'id':complaint_id},{'$set':update})
    if not r.matched_count: raise HTTPException(404,'Complaint not found')
    return await db.complaints.find_one({'id':complaint_id},{'_id':0})

@api_router.post('/complaints')
async def create_complaint(payload: ComplaintCreate, user=Depends(get_current)):
    role=user.get('role')
    if role not in ('customer','driver','manager','admin'): raise HTTPException(403,'Invalid role')
    pickup_pin=None
    if payload.booking_id:
        b=await db.bookings.find_one({'id':payload.booking_id},{'_id':0,'pickup_pin':1,'customer_mobile':1,'driver_id':1})
        if b: pickup_pin=b.get('pickup_pin')
    doc={'id':str(uuid.uuid4()),'role':role,'owner_id':user.get('sub'),'booking_id':payload.booking_id,'pickup_pin':pickup_pin,'subject':payload.subject.strip(),'message':payload.message.strip(),'status':'open','created_at':now_iso(),'updated_at':now_iso()}
    await db.complaints.insert_one(doc); doc.pop('_id',None)
    return doc

@api_router.get('/manager/complaints')
async def manager_complaints(manager=Depends(require_manager)):
    if not manager_can(manager,'complaints','view'):
        raise HTTPException(403,'Complaint permission is OFF')
    return await db.complaints.find({'pickup_pin':{'$in':manager.get('pickup_pins') or []}},{'_id':0}).sort('created_at',-1).to_list(1000)

# ---- Vehicles ----
@api_router.post("/driver/vehicles")
async def add_vehicle(payload: VehicleCreate, user=Depends(require_driver_vehicle)):
    if payload.vehicle_type not in VEHICLE_TYPES:
        raise HTTPException(400, 'Invalid vehicle type')
    doc = {
        'id': str(uuid.uuid4()),
        'owner_id': user['sub'],
        'vehicle_type': payload.vehicle_type,
        'plate_no': payload.plate_no.strip().upper(),
        'capacity': payload.capacity.strip(),
        'rc_photo_id': payload.rc_photo_id,
        'vehicle_photo_id': payload.vehicle_photo_id,
        'status': 'pending',
        'available': True,
        'created_at': now_iso(),
    }
    await db.vehicles.insert_one(doc)
    doc.pop('_id', None)
    driver = await db.drivers.find_one({'id': user['sub']})
    await send_push(
        'admin',
        'New vehicle awaiting approval',
        f"{driver['name']} submitted {doc['vehicle_type']} ({doc['plate_no']}).",
        {'url': '/admin', 'type': 'vehicle_pending'},
    )
    return doc



@api_router.get("/driver/vehicles")
async def my_vehicles(user=Depends(require_driver)):
    cur = db.vehicles.find(
        {
            "$or": [
                {"owner_id": user["sub"]},
                {"driver_id": user["sub"]}
            ]
        },
        {"_id": 0}
    ).sort("created_at", -1)

    return await cur.to_list(200)

@api_router.get("/admin/vehicles")
async def admin_vehicles(status: Optional[str] = None, _=Depends(require_admin)):
    q = {}
    if status:
        q['status'] = status
    vehicles = await db.vehicles.find(q, {'_id': 0}).sort('created_at', -1).to_list(500)
    driver_ids = list({v['owner_id'] for v in vehicles})
    drivers = {d['id']: d async for d in db.drivers.find({'id': {'$in': driver_ids}}, {'_id': 0, 'password_hash': 0})}
    for v in vehicles:
        v['driver'] = drivers.get(v['owner_id'])
    return vehicles
@api_router.patch("/admin/drivers/{driver_id}/approval")
async def admin_driver_approval(
    driver_id: str,
    payload: VehicleAction,
    admin=Depends(require_admin)
):



    driver = await db.drivers.find_one({'id': driver_id})

    if not driver:
        raise HTTPException(404, 'Driver not found')

    approved = payload.action == 'approve'

    await db.drivers.update_one(
        {'id': driver_id},
        {'$set': {
            'approved': approved,
            'active': approved,
            'reviewed_by_admin': admin.get('sub'),
            'reviewed_at': now_iso()
        }}
    )

    return await db.drivers.find_one(
        {'id': driver_id},
        {'_id': 0, 'password_hash': 0}
    )




@api_router.patch("/admin/vehicles/{vehicle_id}")
async def approve_vehicle(vehicle_id: str, payload: VehicleAction, _=Depends(require_admin)):
    v = await db.vehicles.find_one({'id': vehicle_id})
    if not v:
        raise HTTPException(404, 'Vehicle not found')
    approved = payload.action == 'approve'
    new_status = 'approved' if approved else 'rejected'

    await db.vehicles.update_one(
        {'id': vehicle_id},
        {'$set': {
            'approved': approved,
            'status': new_status,
            'available': approved,
            'reviewed_at': now_iso()
        }}
    )    
    await send_push(
        f"driver:{v['owner_id']}",
        f"Vehicle {new_status}",
        f"Your {v['vehicle_type']} ({v['plate_no']}) has been {new_status} by admin.",
        {'url': '/driver', 'type': f'vehicle_{new_status}'},
    )
    return {'id': vehicle_id, 'status': new_status}



    
@api_router.get("/public/vehicles")
async def public_vehicles(vehicle_type: Optional[str] = None):
    # Only approved AND available vehicles are shown to customers.
    q = {'status': 'approved', 'available': {'$ne': False}}
    if vehicle_type:
        q['vehicle_type'] = vehicle_type
    vehicles = await db.vehicles.find(q, {'_id': 0}).to_list(500)
    driver_ids = list({v['owner_id'] for v in vehicles})
    drivers = {d['id']: {'id': d['id'], 'name': d['name']} async for d in db.drivers.find({'id': {'$in': driver_ids}}, {'_id': 0})}
    for v in vehicles:
        v['driver_name'] = drivers.get(v['owner_id'], {}).get('name', 'Driver')
    return vehicles


async def validate_pickup_pin(pickup_pin: Optional[str]):
    pin = (pickup_pin or '').strip()
    if not (pin.isdigit() and len(pin) == 6):
        raise HTTPException(400, 'A valid 6-digit Pickup PIN is required')
    area = await db.service_areas.find_one({'pickup_pin': pin, 'enabled': True}, {'_id': 0})
    if not area:
        raise HTTPException(403, 'AvSGo service is not available for this Pickup PIN')
    return area

# ---- Bookings ----
async def validate_customer_drop_place(drop_place_id: Optional[str], drop_location: str):
    if not drop_place_id:
        raise HTTPException(400, 'Please select a Drop Place from the AvSGo common place list')
    place = await db.drop_places.find_one({'id': drop_place_id, 'enabled': True}, {'_id': 0})
    if not place:
        raise HTTPException(400, 'Selected Drop Place is unavailable')
    return place


@api_router.post("/customer/bookings")
async def create_booking(payload: BookingCreate):
    await validate_pickup_pin(payload.pickup_pin)
    if payload.distance_km <= 0:
        raise HTTPException(400, 'Distance must be greater than 0')
    if len(payload.customer_mobile.strip()) != 10 or not payload.customer_mobile.strip().isdigit():
        raise HTTPException(400, 'Enter a valid 10-digit mobile')
    drop_place = await validate_customer_drop_place(payload.drop_place_id, payload.drop_location)
    vehicle = await db.vehicles.find_one({'id': payload.vehicle_id, 'status': 'approved'})
    if not vehicle or not vehicle.get('available', True):
        raise HTTPException(404, 'Vehicle not available')
    fare_cfg, fare_manager = await resolve_fare(vehicle['vehicle_type'], payload.pickup_pin)
    if not fare_cfg:
        raise HTTPException(500, 'Fare not configured')
    gross_fare = round(float(fare_cfg['base_fare']) + float(fare_cfg['per_km']) * float(payload.distance_km), 2)
    discount_pct, _ = await resolve_discount(payload.pickup_pin)
    discount_amount = round(gross_fare * discount_pct / 100.0, 2)
    fare = round(gross_fare - discount_amount, 2)
    commission = round(fare * (float(fare_cfg.get('commission_pct', 0)) / 100.0), 2)
    doc = {
        'id': str(uuid.uuid4()),
        'vehicle_id': vehicle['id'],
        'vehicle_type': vehicle['vehicle_type'],
        'plate_no': vehicle['plate_no'],
        'driver_id': vehicle['owner_id'],
        'customer_name': payload.customer_name.strip(),
        'customer_mobile': payload.customer_mobile.strip(),
        'pickup': payload.pickup.strip(),
        'drop_location': drop_place.get('place_name') or payload.drop_location.strip(),
        'drop_place_id': drop_place.get('id'),
        'drop_lat': drop_place.get('latitude'),
        'drop_lng': drop_place.get('longitude'),
        'distance_km': payload.distance_km,
        'fare': fare,
        'gross_fare': gross_fare,
        'discount_pct': discount_pct,
        'discount_amount': discount_amount,
        'commission': commission,
        'status': 'requested',
        'driver_mobile': None,
        'pickup_lat': payload.pickup_lat,
        'pickup_lng': payload.pickup_lng,
        'pickup_pin': payload.pickup_pin.strip() if payload.pickup_pin else None,
        'payment_status': 'pending',
        'payment_method': None,
        'payment_received_at': None,
        'auto_assigned': False,
        'created_at': now_iso(),
        'request_expires_at': (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(),
        'trip_stage': 'driver_to_pickup',
    }
    await db.bookings.insert_one(doc)
    doc.pop('_id', None)

    # Notifications
    await send_push(
        f"customer:{doc['customer_mobile']}",
        'Booking request sent',
        f"Your booking for {doc['vehicle_type']} is waiting for the driver to accept.",
        {'url': '/customer', 'type': 'booking_created', 'booking_id': doc['id']},
    )
    await send_push(
        f"driver:{doc['driver_id']}",
        'New booking request',
        f"{doc['customer_name']} • {doc['pickup']} → {doc['drop_location']} • ₹{doc['fare']}",
        {'url': '/driver', 'type': 'new_booking', 'booking_id': doc['id']},
    )
    await send_push(
        'admin',
        'New booking created',
        f"{doc['customer_name']} booked {doc['vehicle_type']} ({doc['plate_no']}) for ₹{doc['fare']}.",
        {'url': '/admin', 'type': 'new_booking'},
    )
    return doc


# ---- Location + auto-assign (GPS nearest driver) ----
LOCATION_FRESH_MIN = 2  # online driver location must be refreshed within 2 minutes


@api_router.post("/driver/location")
async def update_driver_location(payload: DriverLocationIn, user=Depends(require_driver)):
    if not (-90 <= payload.lat <= 90 and -180 <= payload.lng <= 180):
        raise HTTPException(400, 'Invalid coordinates')
    updated_at = now_iso()
    await db.drivers.update_one(
        {'id': user['sub']},
        {'$set': {
            'location': {'type': 'Point', 'coordinates': [payload.lng, payload.lat]},
            'location_accuracy': payload.accuracy,
            'location_updated_at': updated_at,
            'online': True,
        }},
    )
    active = await db.bookings.find({'driver_id': user['sub'], 'status': {'$in': ['accepted','driver_to_pickup','trip_started']}}, {'_id':0,'id':1}).to_list(50)
    for booking in active:
        await ws_manager.booking_event(booking['id'], 'driver_location', {'lat': payload.lat, 'lng': payload.lng, 'accuracy': payload.accuracy, 'updated_at': updated_at})
    return {'ok': True, 'lat': payload.lat, 'lng': payload.lng, 'updated_at': updated_at}


@api_router.patch("/driver/online")
async def set_driver_online(payload: VehicleAvailability, user=Depends(require_driver)):
    await db.drivers.update_one({'id': user['sub']}, {'$set': {'online': bool(payload.available), 'online_updated_at': now_iso()}})
    return {'ok': True, 'online': bool(payload.available)}


@api_router.get("/driver/location")
async def get_driver_location(user=Depends(require_driver)):
    d = await db.drivers.find_one(
        {'id': user['sub']},
        {'_id': 0, 'location': 1, 'location_updated_at': 1, 'location_accuracy': 1},
    )
    if not d or not d.get('location'):
        return {'lat': None, 'lng': None, 'updated_at': None, 'accuracy': None}
    lng, lat = d['location']['coordinates']
    return {
        'lat': lat, 'lng': lng,
        'updated_at': d.get('location_updated_at'),
        'accuracy': d.get('location_accuracy'),
    }


@api_router.post("/customer/location")
async def update_customer_location(payload: CustomerLocationIn):
    if not (-90 <= payload.lat <= 90 and -180 <= payload.lng <= 180):
        raise HTTPException(400, 'Invalid coordinates')
    mobile = payload.customer_mobile.strip()
    if len(mobile) != 10 or not mobile.isdigit():
        raise HTTPException(400, 'Invalid customer mobile')
    booking = await db.bookings.find_one({'customer_mobile': mobile, 'status': {'$in': ['accepted', 'driver_to_pickup', 'trip_started']}}, sort=[('created_at', -1)])
    if not booking:
        return {'ok': True, 'ignored': True}
    updated_at = now_iso()
    await db.bookings.update_one({'id': booking['id']}, {'$set': {'customer_location': {'lat': payload.lat, 'lng': payload.lng, 'accuracy': payload.accuracy}, 'customer_location_updated_at': updated_at}})
    await ws_manager.booking_event(booking['id'], 'customer_location', {'lat': payload.lat, 'lng': payload.lng, 'accuracy': payload.accuracy, 'updated_at': updated_at})
    return {'ok': True, 'booking_id': booking['id'], 'lat': payload.lat, 'lng': payload.lng}


@api_router.post("/customer/bookings/auto")
async def auto_create_booking(payload: BookingAutoCreate):
    await validate_pickup_pin(payload.pickup_pin)
    if payload.distance_km <= 0:
        raise HTTPException(400, 'Distance must be greater than 0')
    if payload.vehicle_type not in VEHICLE_TYPES:
        raise HTTPException(400, 'Invalid vehicle type')
    mobile = payload.customer_mobile.strip()
    if len(mobile) != 10 or not mobile.isdigit():
        raise HTTPException(400, 'Enter a valid 10-digit mobile')
    if not (-90 <= payload.pickup_lat <= 90 and -180 <= payload.pickup_lng <= 180):
        raise HTTPException(400, 'Invalid pickup coordinates')

    drop_place = await validate_customer_drop_place(payload.drop_place_id, payload.drop_location)

    # Persist/refresh the customer profile in the backend DB (not only localStorage).
    await db.customers.update_one(
        {'mobile': mobile},
        {'$set': {'name': payload.customer_name.strip(), 'mobile': mobile, 'pickup_pin': payload.pickup_pin.strip(), 'active': True, 'updated_at': now_iso()},
         '$setOnInsert': {'id': str(uuid.uuid4()), 'created_at': now_iso()}},
        upsert=True,
    )

    # Freshness window
    from datetime import timedelta as _td
    cutoff = (datetime.now(timezone.utc) - _td(minutes=LOCATION_FRESH_MIN)).isoformat()
    max_meters = int((payload.max_radius_km or 15) * 1000)

    pipeline = [
        {'$geoNear': {
            'near': {'type': 'Point', 'coordinates': [payload.pickup_lng, payload.pickup_lat]},
            'distanceField': 'distance_m',
            'maxDistance': max_meters,
            'spherical': True,
            'query': {'location_updated_at': {'$gte': cutoff}, 'approved': True, 'active': True, 'online': True},
        }},
        {'$project': {'_id': 0, 'id': 1, 'name': 1, 'mobile': 1, 'distance_m': 1}},
        {'$limit': 50},
    ]
    try:
        nearby = await db.drivers.aggregate(pipeline).to_list(50)
    except Exception as e:
        logger.error(f"$geoNear failed: {e}")
        raise HTTPException(500, 'Nearest-driver lookup failed')
    if not nearby:
        raise HTTPException(404, 'No online drivers near you right now. Try again shortly.')

    driver_ids = [d['id'] for d in nearby]
    vehicles = await db.vehicles.find({
        'owner_id': {'$in': driver_ids},
        'status': 'approved',
        'available': {'$ne': False},
        'vehicle_type': payload.vehicle_type,
    }, {'_id': 0}).to_list(200)
    by_owner = {}
    for v in vehicles:
        by_owner.setdefault(v['owner_id'], v)

    # Broadcast: send to EVERY nearby driver who has a suitable vehicle.
    eligible = [d for d in nearby if d['id'] in by_owner]
    if not eligible:
        raise HTTPException(404, f'No {payload.vehicle_type} available near you. Try another vehicle type.')

    fare_cfg, fare_manager = await resolve_fare(payload.vehicle_type, payload.pickup_pin)
    if not fare_cfg:
        raise HTTPException(500, 'Fare not configured')
    gross_fare = round(float(fare_cfg['base_fare']) + float(fare_cfg['per_km']) * float(payload.distance_km), 2)
    discount_pct, _ = await resolve_discount(payload.pickup_pin)
    discount_amount = round(gross_fare * discount_pct / 100.0, 2)
    fare = round(gross_fare - discount_amount, 2)
    commission = round(fare * (float(fare_cfg.get('commission_pct', 0)) / 100.0), 2)

    nearest = eligible[0]
    doc = {
        'id': str(uuid.uuid4()),
        'vehicle_id': None,
        'vehicle_type': payload.vehicle_type,
        'plate_no': None,
        'driver_id': None,
        'customer_name': payload.customer_name.strip(),
        'customer_mobile': mobile,
        'pickup': payload.pickup.strip(),
        'drop_location': drop_place.get('place_name') or payload.drop_location.strip(),
        'drop_place_id': drop_place.get('id'),
        'drop_lat': drop_place.get('latitude'),
        'drop_lng': drop_place.get('longitude'),
        'distance_km': payload.distance_km,
        'fare': fare,
        'gross_fare': gross_fare,
        'discount_pct': discount_pct,
        'discount_amount': discount_amount,
        'commission': commission,
        'status': 'requested',
        'driver_mobile': None,
        'pickup_lat': payload.pickup_lat,
        'pickup_lng': payload.pickup_lng,
        'pickup_pin': payload.pickup_pin.strip(),
        'payment_status': 'pending',
        'payment_method': None,
        'payment_received_at': None,
        'auto_assigned': True,
        'broadcast_driver_ids': [d['id'] for d in eligible],
        'broadcast_count': len(eligible),
        'rejected_driver_ids': [],
        'redispatch_count': 0,
        'max_radius_km': float(payload.max_radius_km or 25),
        'driver_distance_m': round(nearest['distance_m'], 1),
        'created_at': now_iso(),
        'request_expires_at': (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(),
        'trip_stage': 'driver_to_pickup',
    }
    await db.bookings.insert_one(doc)
    doc.pop('_id', None)

    nearest_km = round(nearest['distance_m'] / 1000.0, 2)
    await send_push(
        f"customer:{mobile}",
        'Booking broadcast to nearby drivers',
        f"Sent to {len(eligible)} {payload.vehicle_type} driver{'s' if len(eligible)!=1 else ''} nearby. First to accept wins.",
        {'url': '/customer', 'type': 'booking_created', 'booking_id': doc['id']},
    )
    for d in eligible:
        km = round(d['distance_m'] / 1000.0, 2)
        await send_push(
            f"driver:{d['id']}",
            'New booking request (near you)',
            f"{doc['customer_name']} • {doc['pickup']} → {doc['drop_location']} • {km} km away • ₹{doc['fare']} — first to accept wins",
            {'url': '/driver', 'type': 'new_booking', 'booking_id': doc['id']},
        )
        await ws_manager.driver_event(d['id'], 'new_booking', {
            'status': 'requested', 'vehicle_type': doc['vehicle_type'], 'customer_name': doc['customer_name'],
            'pickup': doc['pickup'], 'drop_location': doc['drop_location'], 'fare': doc['fare'],
            'distance_km': doc['distance_km'], 'request_expires_at': doc['request_expires_at'],
        }, booking_id=doc['id'])
    await send_push(
        'admin',
        'Broadcast booking created',
        f"{doc['customer_name']} • {payload.vehicle_type} • sent to {len(eligible)} drivers • ₹{fare}.",
        {'url': '/admin', 'type': 'new_booking'},
    )
    return doc


@api_router.post("/driver/bookings/{booking_id}/payment-received")
async def driver_payment_received(booking_id: str, payload: PaymentReceivedIn, user=Depends(require_driver)):
    b = await db.bookings.find_one({'id': booking_id, 'driver_id': user['sub']})
    if not b: raise HTTPException(404, 'Booking not found')
    if b.get('status') != 'completed': raise HTTPException(400, 'Trip must be completed first')
    if b.get('payment_status') == 'completed': return b
    await db.bookings.update_one({'id': booking_id, 'driver_id': user['sub']},
        {'$set': {'payment_status':'completed','payment_method':payload.payment_method,'payment_received_at':now_iso()}})
    updated = await db.bookings.find_one({'id': booking_id}, {'_id': 0})
    await ws_manager.booking_event(booking_id, 'payment_updated', {'payment_status': updated.get('payment_status'), 'payment_method': updated.get('payment_method')})
    return updated

@api_router.get("/customer/bookings/{booking_id}")
async def customer_booking_status(booking_id: str):
    b = await db.bookings.find_one({'id': booking_id}, {'_id': 0})
    if not b:
        raise HTTPException(404, 'Booking not found')
    if b['status'] not in ('accepted', 'driver_to_pickup', 'trip_started', 'completed'):
        b['driver_mobile'] = None
    return b


@api_router.post("/customer/bookings/{booking_id}/cancel")
async def cancel_booking(booking_id: str, mobile: str = Query(...)):
    b = await db.bookings.find_one({'id': booking_id})
    if not b:
        raise HTTPException(404, 'Booking not found')
    if b['customer_mobile'] != mobile.strip():
        raise HTTPException(403, 'Mobile does not match booking')
    if b['status'] in ('completed', 'rejected', 'cancelled'):
        raise HTTPException(400, 'Cannot cancel this booking')
    await db.bookings.update_one({'id': booking_id}, {'$set': {'status': 'cancelled', 'cancelled_at': now_iso()}})
    await send_push(
        f"customer:{b['customer_mobile']}",
        'Booking cancelled',
        f"Your booking for {b['vehicle_type']} has been cancelled.",
        {'url': '/customer', 'type': 'booking_cancelled'},
    )
    await send_push(
        f"driver:{b['driver_id']}",
        'Booking cancelled by customer',
        f"{b['customer_name']} cancelled the {b['vehicle_type']} booking.",
        {'url': '/driver', 'type': 'booking_cancelled'},
    )
    return {'id': booking_id, 'status': 'cancelled'}


@api_router.get("/driver/bookings")
async def driver_bookings(user=Depends(require_driver)):
    # Return bookings this driver owns, PLUS unclaimed broadcast requests targeted at them.
    q = {'$or': [
        {'driver_id': user['sub']},
        {'broadcast_driver_ids': user['sub'], 'status': 'requested', 'driver_id': None},
    ]}
    cur = db.bookings.find(q, {'_id': 0}).sort('created_at', -1)
    items = await cur.to_list(500)
    now = datetime.now(timezone.utc)
    for b in items:
        expires = b.get('request_expires_at')
        # Expiry/re-dispatch is handled centrally by the background worker so one driver polling
        # cannot prematurely kill a booking for every other eligible driver.
        b['is_broadcast'] = bool(b.get('broadcast_driver_ids')) and b.get('driver_id') is None
        b['mine'] = b.get('driver_id') == user['sub']
    return items


@api_router.patch("/driver/bookings/{booking_id}")
async def driver_booking_action(booking_id: str, payload: BookingAction, user=Depends(require_driver)):
    b = await db.bookings.find_one({'id': booking_id})
    if not b:
        raise HTTPException(404, 'Booking not found')
    was_broadcast_target = user['sub'] in (b.get('broadcast_driver_ids') or [])
    is_broadcast = b.get('driver_id') is None and was_broadcast_target
    is_owner = b.get('driver_id') == user['sub']
    if not (is_broadcast or is_owner):
        # Broadcast participant who lost the race → tell them so instead of 404.
        if was_broadcast_target and b.get('driver_id') and b.get('driver_id') != user['sub']:
            raise HTTPException(409, 'This booking was already accepted by another driver')
        raise HTTPException(404, 'Booking not found')

    driver = await db.drivers.find_one({'id': user['sub']})

    if b.get('status') == 'requested' and b.get('request_expires_at'):
        try:
            if datetime.fromisoformat(b['request_expires_at']) <= datetime.now(timezone.utc):
                raise HTTPException(410, '30-second request timer expired; the booking is being re-dispatched')
        except ValueError:
            pass

    # ---------- Broadcast: first-accept-wins ----------
    if is_broadcast and payload.action == 'accept':
        my_vehicle = await db.vehicles.find_one({
            'owner_id': user['sub'],
            'status': 'approved',
            'available': {'$ne': False},
            'vehicle_type': b['vehicle_type'],
        })
        if not my_vehicle:
            raise HTTPException(400, f"You have no available {b['vehicle_type']} to accept this booking")
        updated = await db.bookings.find_one_and_update(
            {'id': booking_id, 'status': 'requested', 'driver_id': None,
             'broadcast_driver_ids': user['sub']},
            {'$set': {
                'status': 'accepted',
                'driver_id': user['sub'],
                'driver_mobile': driver['mobile'],
                'vehicle_id': my_vehicle['id'],
                'plate_no': my_vehicle['plate_no'],
                'accepted_at': now_iso(),
            }},
            projection={'_id': 0},
            return_document=ReturnDocument.AFTER,
        )
        if not updated:
            raise HTTPException(409, 'This booking was already accepted by another driver')

        # Notify customer
        await send_push(
            f"customer:{updated['customer_mobile']}",
            'Driver accepted your booking!',
            f"{driver['name']} accepted. Call {driver['mobile']} to coordinate pickup.",
            {'url': '/customer', 'booking_id': booking_id, 'type': 'booking_accept'},
        )
        # Notify losing drivers
        losers = [d for d in (updated.get('broadcast_driver_ids') or []) if d != user['sub']]
        for other in losers:
            await send_push(
                f"driver:{other}",
                'Booking already taken',
                f"A nearby {updated['vehicle_type']} booking was just accepted by another driver.",
                {'url': '/driver', 'type': 'booking_lost', 'booking_id': booking_id},
            )
            await ws_manager.driver_event(other, 'booking_lost', {'status': 'accepted', 'winner_driver_id': updated.get('driver_id')}, booking_id=booking_id)
        # Admin
        await send_push(
            'admin',
            'Broadcast booking accepted',
            f"{driver['name']} accepted the {updated['vehicle_type']} broadcast booking.",
            {'url': '/admin', 'type': 'booking_accept'},
        )
        await ws_manager.booking_event(booking_id, 'booking_updated', {'status': updated.get('status'), 'driver_id': updated.get('driver_id'), 'driver_mobile': updated.get('driver_mobile')})
        return updated

    if is_broadcast and payload.action == 'reject':
        # Remove self from broadcast list. If nobody left, mark rejected.
        await db.bookings.update_one(
            {'id': booking_id, 'broadcast_driver_ids': user['sub'], 'status': 'requested', 'driver_id': None},
            {'$pull': {'broadcast_driver_ids': user['sub']}},
        )
        b2 = await db.bookings.find_one({'id': booking_id}, {'_id': 0})
        if (
            b2 and b2.get('status') == 'requested'
            and not b2.get('driver_id')
            and not b2.get('broadcast_driver_ids')
        ):
            await db.bookings.update_one(
                {'id': booking_id, 'status': 'requested', 'driver_id': None},
                {'$set': {'status': 'rejected', 'rejected_at': now_iso()}},
            )
            b2['status'] = 'rejected'
            await send_push(
                f"customer:{b2['customer_mobile']}",
                'No driver available',
                f"No nearby {b2['vehicle_type']} driver could accept. Please try again.",
                {'url': '/customer', 'type': 'booking_all_rejected'},
            )
        await ws_manager.booking_event(booking_id, 'booking_updated', {'status': b2.get('status') if b2 else 'requested'})
        return b2

    if is_broadcast:
        raise HTTPException(400, 'Only accept/reject allowed on broadcast requests')

    # ---------- Single-driver (existing) flow ----------
    update = {}
    push_title = push_body = None
    if payload.action == 'accept':
        if b['status'] != 'requested':
            raise HTTPException(400, 'Booking cannot be accepted')
        update = {'status': 'accepted', 'driver_mobile': driver['mobile'], 'accepted_at': now_iso()}
        push_title = 'Booking accepted!'
        push_body = f"Driver {driver['name']} accepted. Call {driver['mobile']} to coordinate."
    elif payload.action == 'reject':
        if b['status'] != 'requested':
            raise HTTPException(400, 'Booking cannot be rejected')
        update = {'status': 'rejected', 'rejected_at': now_iso()}
        push_title = 'Booking rejected'
        push_body = f"The driver could not accept your {b['vehicle_type']} booking. Please try another vehicle."
    elif payload.action == 'complete':
        if b['status'] not in ('accepted', 'driver_to_pickup', 'trip_started'):
            raise HTTPException(400, 'Only active trips can be completed')
        update = {'status': 'completed', 'completed_at': now_iso()}
        push_title = 'Trip completed'
        push_body = f"Your {b['vehicle_type']} trip is complete. Thanks for using AvSGo!"
    else:
        raise HTTPException(400, 'Invalid action')

    await db.bookings.update_one({'id': booking_id}, {'$set': update})
    if push_title:
        await send_push(
            f"customer:{b['customer_mobile']}",
            push_title, push_body,
            {'url': '/customer', 'booking_id': booking_id, 'type': f'booking_{payload.action}'},
        )
    updated = await db.bookings.find_one({'id': booking_id}, {'_id': 0})
    await ws_manager.booking_event(booking_id, 'booking_updated', {'status': updated.get('status'), 'trip_stage': updated.get('trip_stage'), 'driver_id': updated.get('driver_id')})
    return updated


@api_router.patch("/driver/bookings/{booking_id}/trip")
async def driver_trip_action(booking_id: str, payload: TripAction, user=Depends(require_driver)):
    b = await db.bookings.find_one({'id': booking_id, 'driver_id': user['sub']})
    if not b:
        raise HTTPException(404, 'Trip not found')
    if payload.action == 'start':
        if b.get('status') != 'accepted': raise HTTPException(400, 'Trip is not ready to start')
        update = {'status': 'trip_started', 'trip_stage': 'in_trip', 'trip_started_at': now_iso()}
    elif payload.action == 'reach_pickup':
        if b.get('status') not in ('accepted', 'driver_to_pickup'): raise HTTPException(400, 'Invalid trip stage')
        update = {'status': 'driver_to_pickup', 'trip_stage': 'at_pickup', 'reached_pickup_at': now_iso()}
    elif payload.action == 'end':
        if b.get('status') != 'trip_started': raise HTTPException(400, 'Trip is not started')
        update = {'status': 'completed', 'trip_stage': 'completed', 'completed_at': now_iso()}
    await db.bookings.update_one({'id': booking_id}, {'$set': update})
    updated = await db.bookings.find_one({'id': booking_id}, {'_id': 0})
    await ws_manager.booking_event(booking_id, 'trip_updated', {'status': updated.get('status'), 'trip_stage': updated.get('trip_stage')})
    return updated


@api_router.post("/customer/bookings/{booking_id}/start-trip")
async def customer_start_trip(booking_id: str, mobile: str = Query(...)):
    b = await db.bookings.find_one({'id': booking_id, 'customer_mobile': mobile.strip()})
    if not b: raise HTTPException(404, 'Booking not found')
    if b.get('status') != 'driver_to_pickup': raise HTTPException(400, 'Driver has not reached pickup yet')
    await db.bookings.update_one({'id': booking_id}, {'$set': {'status': 'trip_started', 'trip_stage': 'in_trip', 'trip_started_at': now_iso()}})
    updated = await db.bookings.find_one({'id': booking_id}, {'_id': 0})
    await ws_manager.booking_event(booking_id, 'trip_updated', {'status': updated.get('status'), 'trip_stage': updated.get('trip_stage')})
    return updated


@api_router.get("/customer/bookings/{booking_id}/trip")
async def customer_trip_state(booking_id: str, mobile: str = Query(...)):
    b = await db.bookings.find_one({'id': booking_id, 'customer_mobile': mobile.strip()}, {'_id': 0})
    if not b: raise HTTPException(404, 'Booking not found')
    driver_loc = None
    if b.get('driver_id'):
        d = await db.drivers.find_one({'id': b['driver_id']}, {'_id': 0, 'location': 1, 'location_updated_at': 1})
        if d and d.get('location'):
            lng, lat = d['location']['coordinates']; driver_loc = {'lat': lat, 'lng': lng, 'updated_at': d.get('location_updated_at')}
    return {'booking_id': booking_id, 'status': b.get('status'), 'trip_stage': b.get('trip_stage'), 'pickup': {'lat': b.get('pickup_lat'), 'lng': b.get('pickup_lng'), 'label': b.get('pickup')}, 'drop': {'lat': b.get('drop_lat'), 'lng': b.get('drop_lng'), 'label': b.get('drop_location')}, 'driver_location': driver_loc, 'customer_location': b.get('customer_location')}


@api_router.get("/driver/bookings/{booking_id}/trip")
async def driver_trip_state(booking_id: str, user=Depends(require_driver)):
    b = await db.bookings.find_one({'id': booking_id, 'driver_id': user['sub']}, {'_id': 0})
    if not b: raise HTTPException(404, 'Trip not found')
    return {'booking_id': booking_id, 'status': b.get('status'), 'trip_stage': b.get('trip_stage'), 'pickup': {'lat': b.get('pickup_lat'), 'lng': b.get('pickup_lng'), 'label': b.get('pickup')}, 'drop': {'lat': b.get('drop_lat'), 'lng': b.get('drop_lng'), 'label': b.get('drop_location')}, 'customer_location': b.get('customer_location')}


@api_router.get("/admin/bookings")
async def admin_bookings(_=Depends(require_admin)):
    cur = db.bookings.find({}, {'_id': 0}).sort('created_at', -1)
    return await cur.to_list(1000)


# ---- Drivers ----
@api_router.get("/admin/drivers")
async def admin_drivers(_=Depends(require_admin)):
    cur = db.drivers.find({}, {'_id': 0, 'password_hash': 0}).sort('created_at', -1)
    drivers = await cur.to_list(500)
    # Single aggregation for all drivers to avoid N+1
    pipeline = [
        {'$match': {'status': 'completed', 'commission_paid': {'$ne': True}}},
        {'$group': {'_id': '$driver_id', 'total': {'$sum': '$commission'}, 'count': {'$sum': 1}}},
    ]
    commission_map = {}
    async for row in db.bookings.aggregate(pipeline):
        commission_map[row['_id']] = row
    for d in drivers:
        row = commission_map.get(d['id'])
        d['commission_owed'] = round(row['total'], 2) if row else 0
        d['completed_trips'] = row['count'] if row else 0
    return drivers


# ---- Notifications ----
@api_router.post("/admin/notify-driver")
async def notify_driver(payload: NotifyDriver, _=Depends(require_admin)):
    driver = await db.drivers.find_one({'id': payload.driver_id})
    if not driver:
        raise HTTPException(404, 'Driver not found')
    pipeline = [
        {'$match': {'driver_id': driver['id'], 'status': 'completed', 'commission_paid': {'$ne': True}}},
        {'$group': {'_id': None, 'total': {'$sum': '$commission'}}},
    ]
    agg = await db.bookings.aggregate(pipeline).to_list(1)
    owed = round(agg[0]['total'], 2) if agg else 0
    admin_pay = await db.payment_settings.find_one({'owner_type':'admin','owner_id':'admin','active':True},{'_id':0,'upi_id':1})
    admin_upi = (admin_pay or {}).get('upi_id') or ADMIN_UPI
    msg = payload.message or (
        f"Please pay pending commission of ₹{owed} to Admin UPI: {admin_upi}. Thank you!"
    )
    doc = {
        'id': str(uuid.uuid4()),
        'driver_id': driver['id'],
        'message': msg,
        'amount': owed,
        'upi': admin_upi,
        'created_at': now_iso(),
        'read': False,
    }
    await db.notifications.insert_one(doc)
    doc.pop('_id', None)
    await send_push(
        f"driver:{driver['id']}",
        f"Commission reminder • ₹{owed}",
        msg,
        {'url': '/driver', 'type': 'commission_reminder'},
    )
    return doc


@api_router.get("/driver/notifications")
async def driver_notifications(user=Depends(require_driver)):
    cur = db.notifications.find({'driver_id': user['sub']}, {'_id': 0}).sort('created_at', -1)
    return await cur.to_list(200)


# ---- In-App Notification Bell (drivers + admin) ----
@api_router.get("/inapp/notifications")
async def inapp_list(user=Depends(get_current)):
    key = 'admin' if user['role'] == 'admin' else f"driver:{user['sub']}"
    items = await db.inapp_notifications.find(
        {'recipient_key': key}, {'_id': 0}
    ).sort('created_at', -1).limit(50).to_list(50)
    unread = await db.inapp_notifications.count_documents({'recipient_key': key, 'read': False})
    return {'items': items, 'unread': unread}


class MarkReadIn(BaseModel):
    id: Optional[str] = None


@api_router.post("/inapp/notifications/mark-read")
async def inapp_mark_read(payload: MarkReadIn, user=Depends(get_current)):
    key = 'admin' if user['role'] == 'admin' else f"driver:{user['sub']}"
    q = {'recipient_key': key, 'read': False}
    if payload.id:
        q['id'] = payload.id
    r = await db.inapp_notifications.update_many(q, {'$set': {'read': True, 'read_at': now_iso()}})
    return {'ok': True, 'updated': r.modified_count}


@api_router.get("/driver/commission")
async def driver_commission(user=Depends(require_driver)):
    # Total pending commission (unpaid) + lifetime earnings + total paid
    owed_pipeline = [
        {'$match': {'driver_id': user['sub'], 'status': 'completed', 'commission_paid': {'$ne': True}}},
        {'$group': {'_id': None, 'total': {'$sum': '$commission'}, 'trips': {'$sum': 1}}},
    ]
    earn_pipeline = [
        {'$match': {'driver_id': user['sub'], 'status': 'completed'}},
        {'$group': {'_id': None, 'earnings': {'$sum': '$fare'}, 'trips': {'$sum': 1}}},
    ]
    paid_pipeline = [
        {'$match': {'driver_id': user['sub'], 'status': 'completed', 'commission_paid': True}},
        {'$group': {'_id': None, 'paid': {'$sum': '$commission'}}},
    ]
    owed = await db.bookings.aggregate(owed_pipeline).to_list(1)
    earn = await db.bookings.aggregate(earn_pipeline).to_list(1)
    paid = await db.bookings.aggregate(paid_pipeline).to_list(1)
    admin_pay = await db.payment_settings.find_one({'owner_type':'admin','owner_id':'admin','active':True},{'_id':0,'upi_id':1,'qr_file_id':1})
    admin_upi = (admin_pay or {}).get('upi_id') or ADMIN_UPI
    return {
        'commission_owed': round(owed[0]['total'], 2) if owed else 0,
        'commission_paid': round(paid[0]['paid'], 2) if paid else 0,
        'total_earnings': round(earn[0]['earnings'], 2) if earn else 0,
        'trips': earn[0]['trips'] if earn else 0,
        'upi': admin_upi,
        'qr_file_id': (admin_pay or {}).get('qr_file_id'),
    }


# ---- Owner payout (admin) ----
class PayCommissionIn(BaseModel):
    amount: float
    utr: str


class RouteIn(BaseModel):
    pickup_lat: float
    pickup_lng: float
    drop_lat: float
    drop_lng: float
    vehicle_type: Optional[str] = None


def _haversine_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    import math
    R = 6371.0088
    dlat = math.radians(b_lat - a_lat)
    dlng = math.radians(b_lng - a_lng)
    h = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def _osrm_route(pickup_lat, pickup_lng, drop_lat, drop_lng):
    """Public OSRM demo server — real road distance + GeoJSON polyline. No API key needed.
    Returns (distance_km, duration_min, coords[[lat,lng],...]) or raises."""
    url = (
        f"https://router.project-osrm.org/route/v1/driving/"
        f"{pickup_lng},{pickup_lat};{drop_lng},{drop_lat}"
    )
    r = requests.get(
        url,
        params={'overview': 'full', 'geometries': 'geojson', 'steps': 'false'},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 'Ok' or not data.get('routes'):
        raise RuntimeError(f"OSRM: {data.get('message', 'no route found')}")
    rt = data['routes'][0]
    # GeoJSON coords are [lng, lat] — flip for Leaflet ([lat, lng])
    coords = [[c[1], c[0]] for c in rt['geometry']['coordinates']]
    return round(rt['distance'] / 1000.0, 2), round(rt['duration'] / 60.0, 1), coords


def _ors_route(pickup_lat, pickup_lng, drop_lat, drop_lng):
    """Call OpenRouteService driving-hgv (used as fallback when a key is configured).
    Returns (distance_km, duration_min, coords[[lat,lng],...]) or raises."""
    r = requests.post(
        'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
        headers={'Authorization': ROUTING_API_KEY, 'Content-Type': 'application/json'},
        json={'coordinates': [[pickup_lng, pickup_lat], [drop_lng, drop_lat]]},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    feat = data['features'][0]
    seg = feat['properties']['summary']
    coords = [[c[1], c[0]] for c in feat['geometry']['coordinates']]
    return round(seg['distance'] / 1000.0, 2), round(seg['duration'] / 60.0, 1), coords


@api_router.get("/geocode")
async def geocode(
    q: str = Query(..., min_length=1),
    limit: int = Query(8, ge=1, le=15),
    west: Optional[float] = None,
    south: Optional[float] = None,
    east: Optional[float] = None,
    north: Optional[float] = None,
    bounded: int = Query(0, ge=0, le=1),
):
    """Free-text → list of {display_name, lat, lng} via Nominatim (public, no key).

    When west/south/east/north are ALL provided, the request is scoped to that
    bounding box using Nominatim's `viewbox` + `bounded` (0=soft bias, 1=strict).
    Otherwise the Assam viewbox is used as a soft country-wide bias.
    """
    params = {
        'q': q,
        'format': 'json',
        'limit': limit,
        'countrycodes': 'in',
        'addressdetails': 0,
        'dedupe': 1,
    }
    have_bbox = all(v is not None for v in (west, south, east, north))
    if have_bbox:
        # Nominatim viewbox order: left, top, right, bottom  = west, north, east, south
        params['viewbox'] = f'{west},{north},{east},{south}'
        params['bounded'] = 1 if bounded else 0
    else:
        params['viewbox'] = '89.7,28.2,96.0,24.1'  # Assam soft bias
        params['bounded'] = 0

    def _call(p):
        try:
            resp = requests.get(
                'https://nominatim.openstreetmap.org/search',
                params=p,
                headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'},
                timeout=12,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.warning(f'geocode failed: {e}')
            return []

    rows = _call(params)

    # Rural PIN areas can have sparse OSM data. If the strict bbox returned nothing,
    # expand the box ~1.8x (still bounded, to stay in the same district) and retry once.
    if have_bbox and params.get('bounded') == 1 and not rows:
        try:
            w, n, e_, s = west, north, east, south  # noqa: E741
            cx, cy = (w + e_) / 2, (s + n) / 2
            hw = (e_ - w) / 2 * 1.8
            hh = (n - s) / 2 * 1.8
            expanded = dict(params)
            expanded['viewbox'] = f'{cx - hw},{cy + hh},{cx + hw},{cy - hh}'
            rows = _call(expanded)
        except Exception:
            pass

    return {'results': [
        {'display_name': x.get('display_name'), 'lat': float(x['lat']), 'lng': float(x['lon']),
         'type': x.get('type'), 'category': x.get('class')}
        for x in rows
    ]}


@api_router.get("/config/maps")
async def config_maps():
    """Returns the Google Maps browser-referrer-restricted key so the SPA can call
    Google Places directly with the correct Referer. Server-side proxy is not
    possible with a referrer-restricted key; browser keys are Google's designated
    pattern (safe because the key is locked to your app's origin)."""
    return {'google_maps_api_key': GOOGLE_MAPS_API_KEY or None}


@api_router.get("/places/google/autocomplete")
async def google_places_autocomplete(
    q: str = Query(..., min_length=1),
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    radius_m: int = Query(20000, ge=500, le=50000),
    session_token: Optional[str] = None,
):
    """Google Places API (New) autocomplete proxy — server-side so the API key
    never touches the browser. `session_token` MUST be reused across every
    keystroke of one typing session and then forwarded to google_place_details
    to be billed as a single session (per-session pricing, not per-keystroke)."""
    if not GOOGLE_MAPS_API_KEY:
        raise HTTPException(503, 'Google Places API is not configured. Set GOOGLE_MAPS_API_KEY in backend/.env')

    body = {
        'input': q,
        'includedRegionCodes': ['in'],
        'languageCode': 'en',
    }
    if session_token:
        body['sessionToken'] = session_token
    if lat is not None and lng is not None:
        body['locationBias'] = {
            'circle': {
                'center': {'latitude': lat, 'longitude': lng},
                'radius': float(radius_m),
            }
        }

    def _call():
        try:
            r = requests.post(
                'https://places.googleapis.com/v1/places:autocomplete',
                json=body,
                headers={
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
                },
                timeout=8,
            )
            if r.status_code >= 400:
                logger.warning(f'google autocomplete {r.status_code}: {r.text[:250]}')
                return None
            return r.json()
        except Exception as e:
            logger.warning(f'google autocomplete failed: {e}')
            return None

    data = await asyncio.get_event_loop().run_in_executor(None, _call)
    if data is None:
        # Do not fake data — surface a clean 502 so the frontend can fall back.
        raise HTTPException(502, 'Google Places autocomplete unavailable')

    out = []
    for s in (data.get('suggestions') or []):
        pp = s.get('placePrediction') or {}
        sf = pp.get('structuredFormat') or {}
        primary = ((sf.get('mainText') or {}).get('text')) or ((pp.get('text') or {}).get('text'))
        secondary = (sf.get('secondaryText') or {}).get('text')
        display = primary or ''
        if secondary:
            display = f'{primary}, {secondary}' if primary else secondary
        out.append({
            'place_id': pp.get('placeId'),
            'display_name': display,
            'primary': primary,
            'secondary': secondary,
        })
    return {'results': out, 'source': 'google', 'count': len(out)}


@api_router.get("/places/google/details/{place_id}")
async def google_place_details(place_id: str, session_token: Optional[str] = None):
    """Google Place Details (New) — call once after the customer taps a suggestion.
    Returns {lat, lng, formatted_address, name} for the exact drop coordinates."""
    if not GOOGLE_MAPS_API_KEY:
        raise HTTPException(503, 'Google Places API is not configured. Set GOOGLE_MAPS_API_KEY in backend/.env')

    def _call():
        try:
            params = {'languageCode': 'en', 'regionCode': 'in'}
            if session_token:
                params['sessionToken'] = session_token
            r = requests.get(
                f'https://places.googleapis.com/v1/places/{place_id}',
                params=params,
                headers={
                    'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
                },
                timeout=8,
            )
            if r.status_code >= 400:
                logger.warning(f'google details {r.status_code}: {r.text[:250]}')
                return None
            return r.json()
        except Exception as e:
            logger.warning(f'google details failed: {e}')
            return None

    data = await asyncio.get_event_loop().run_in_executor(None, _call)
    if data is None:
        raise HTTPException(502, 'Google Place Details unavailable')

    loc = data.get('location') or {}
    lat = loc.get('latitude')
    lng = loc.get('longitude')
    if lat is None or lng is None:
        raise HTTPException(422, 'Selected place has no coordinates')
    name = (data.get('displayName') or {}).get('text') or data.get('formattedAddress')
    return {
        'place_id': data.get('id'),
        'name': name,
        'formatted_address': data.get('formattedAddress'),
        'lat': float(lat),
        'lng': float(lng),
        'display_name': data.get('formattedAddress') or name,
    }


@api_router.get("/places/autocomplete")
async def places_autocomplete(
    q: str = Query(..., min_length=1),
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    west: Optional[float] = None,
    south: Optional[float] = None,
    east: Optional[float] = None,
    north: Optional[float] = None,
    limit: int = Query(10, ge=1, le=15),
):
    """Real prefix-aware places autocomplete via Photon (OSM-backed, no API key).

    Strategy for rural PIN codes with sparse OSM data:
      1. Strict PIN bbox
      2. If fewer than `limit` unique hits, widen bbox 3× and merge
      3. Still short? Widen 6× and merge again
      4. Still short? Widen 12× (covers the whole district cluster) and merge
      5. Photon-empty (network) → Nominatim bbox fallback

    Merged results are de-duplicated by coordinates and sorted by proximity to
    the lat/lng bias so the nearest hit is always at the top.
    """
    have_bbox = all(v is not None for v in (west, south, east, north))
    if not have_bbox:
        # Assam-wide fallback bbox
        west, south, east, north = 89.7, 24.1, 96.0, 28.2

    base = {'q': q, 'limit': limit, 'lang': 'en'}
    if lat is not None and lng is not None:
        base['lat'] = lat
        base['lon'] = lng
        base['location_bias_scale'] = 1.6

    def _photon(bbox_str):
        try:
            p = dict(base, bbox=bbox_str)
            r = requests.get('https://photon.komoot.io/api', params=p,
                             headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'}, timeout=12)
            r.raise_for_status()
            return r.json().get('features') or []
        except Exception as e:
            logger.warning(f'photon call failed ({bbox_str}): {e}')
            return []

    cx, cy = (west + east) / 2, (south + north) / 2
    hw_base = max((east - west) / 2, 0.02)   # min 2 km lateral so PIN with tiny bbox still widens usefully
    hh_base = max((north - south) / 2, 0.02)

    merged, seen = [], set()
    def _absorb(feats):
        for f in feats:
            c = (f.get('geometry') or {}).get('coordinates') or []
            if len(c) < 2:
                continue
            key = (round(c[1], 5), round(c[0], 5))
            if key in seen:
                continue
            seen.add(key)
            merged.append(f)

    # Widen progressively — 1× (strict, "within PIN"), then 3×/6×/12× ("nearest PIN")
    # but hard-cap the widened half-extent to ~0.45° (~50 km) so we never leak
    # to far-away same-named places in other states.
    MAX_HALF_DEG = 0.45
    for factor in (1, 3, 6, 12):
        hw = min(hw_base * factor, MAX_HALF_DEG)
        hh = min(hh_base * factor, MAX_HALF_DEG)
        bbox_str = f'{cx - hw},{cy - hh},{cx + hw},{cy + hh}'
        _absorb(_photon(bbox_str))
        if len(merged) >= limit:
            break

    # Generic category words we want to *exclude* from proper-noun extraction —
    # a search for "Madhabdev University" is meant to find "Madhabdev" (the
    # proper noun), not any random "University".
    GENERIC_SUFFIXES = {
        'college', 'school', 'university', 'institute', 'hospital', 'clinic',
        'market', 'shop', 'store', 'mall', 'road', 'lane', 'stand', 'station',
        'bank', 'atm', 'temple', 'namghar', 'church', 'mosque', 'hotel',
        'restaurant', 'petrol', 'pump', 'chowk', 'nagar', 'gaon', 'pur',
        'gate', 'point', 'junction', 'circle', 'center', 'centre',
    }

    # If the exact multi-word query returned nothing (common for compound names
    # like "Bihpuria College" that aren't literally indexed), relax to the
    # longest proper-noun-like token so nearby landmarks (Bihpuria CHC,
    # Bihpuria Town Field, Bihpuria Sub Post Office…) still surface.
    if not merged:
        import re as _re
        tokens = [t for t in _re.findall(r"[A-Za-z][A-Za-z0-9]{2,}", q)]
        tokens = [t for t in tokens if t.lower() not in GENERIC_SUFFIXES]
        if tokens:
            broadest = max(tokens, key=len)
            alt_base = dict(base, q=broadest)
            def _photon_alt(bbox_str):
                try:
                    p = dict(alt_base, bbox=bbox_str)
                    r = requests.get('https://photon.komoot.io/api', params=p,
                                     headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'}, timeout=12)
                    r.raise_for_status()
                    return r.json().get('features') or []
                except Exception as e:
                    logger.warning(f'photon relax failed: {e}')
                    return []
            for factor in (1, 3, 6, 12):
                hw = min(hw_base * factor, 0.45)
                hh = min(hh_base * factor, 0.45)
                bbox_str = f'{cx - hw},{cy - hh},{cx + hw},{cy + hh}'
                _absorb(_photon_alt(bbox_str))
                if len(merged) >= limit:
                    break

    # Real institutions that OSM hasn't tagged (e.g. new universities/colleges)
    # → look them up in Wikipedia with a strict distance filter so only nearby
    # matches surface. This is a third preference after: 1) within PIN, 2) nearest PIN.
    # We also trigger Wikipedia when Photon returned something but *none of the
    # results actually contain the primary token* — that means Photon widened
    # to unrelated same-category places (e.g. any nearby "University" instead of
    # the specific one the customer typed).
    primary_token = ''
    if q:
        import re as _re2
        toks = [t for t in _re2.findall(r"[A-Za-z][A-Za-z0-9]{2,}", q) if len(t) >= 3]
        toks = [t for t in toks if t.lower() not in GENERIC_SUFFIXES] or toks
        primary_token = (max(toks, key=len) if toks else q.split()[0]).lower()

    def _semantically_matches(feat):
        props = feat.get('properties') or {}
        blob = ' '.join([
            (props.get('name') or ''),
            (props.get('street') or ''),
            (props.get('city') or ''),
            (props.get('district') or ''),
            (props.get('county') or ''),
        ]).lower()
        return primary_token and primary_token in blob

    needs_wiki = (not merged) or (primary_token and not any(_semantically_matches(f) for f in merged))
    if needs_wiki and lat is not None and lng is not None and len(q) >= 3:
        wiki = _wikipedia_geosearch(q, lat, lng, max_km=60.0, limit=6)
        wiki_feats = []
        for w in wiki:
            wiki_feats.append({
                'geometry': {'type': 'Point', 'coordinates': [w['lng'], w['lat']]},
                'properties': {
                    'name': w['title'],
                    'city': (w.get('summary') or '')[:80],
                    'osm_key': 'wikipedia',
                    'type': 'landmark',
                },
            })
        # Prepend wiki hits so real Wikipedia landmarks appear first when Photon
        # missed the actual entity the customer meant.
        merged = wiki_feats + [m for m in merged if ((m.get('properties') or {}).get('osm_key') != 'wikipedia')]

    # Sort by distance to bias (or bbox centre) so nearest is first
    def _dist(f):
        c = f['geometry']['coordinates']
        dx = c[0] - (lng if lng is not None else cx)
        dy = c[1] - (lat if lat is not None else cy)
        return dx * dx + dy * dy
    merged.sort(key=_dist)

    results = []
    for f in merged[:limit]:
        c = f['geometry']['coordinates']
        p = f.get('properties') or {}
        parts = [
            p.get('name'),
            p.get('street'),
            p.get('district') or p.get('locality'),
            p.get('city'),
            p.get('county'),
            p.get('state'),
            p.get('postcode'),
        ]
        display = ', '.join([x for x in parts if x]) or p.get('name') or 'Unknown location'
        results.append({
            'display_name': display,
            'lat': float(c[1]),
            'lng': float(c[0]),
            'type': p.get('type'),
            'category': p.get('osm_key'),
        })

    # Photon-empty (network issue) → Nominatim bbox fallback
    if not results:
        try:
            nom_params = {
                'q': q, 'format': 'json', 'limit': limit,
                'countrycodes': 'in', 'dedupe': 1, 'addressdetails': 0,
                'viewbox': f'{west},{north},{east},{south}', 'bounded': 0,
            }
            nr = requests.get('https://nominatim.openstreetmap.org/search', params=nom_params,
                              headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'}, timeout=12)
            nr.raise_for_status()
            for x in nr.json():
                results.append({
                    'display_name': x.get('display_name'),
                    'lat': float(x['lat']), 'lng': float(x['lon']),
                    'type': x.get('type'), 'category': x.get('class'),
                })
        except Exception as e:
            logger.warning(f'nominatim fallback failed: {e}')

    return {
        'results': results,
        'source': 'photon' if merged else ('nominatim' if results else 'empty'),
        'count': len(results),
    }


_PIN_CACHE: Dict[str, Any] = {}
_PIN_CACHE_TTL_OK = 60 * 60 * 12   # 12 h for successful lookups (essentially static data)
_PIN_CACHE_TTL_FAIL = 60           # 60 s negative cache to avoid hammering rate-limited APIs

# Sessions with browser-like headers — some public APIs (postalpincode.in) block bare python-requests UA.
_PIN_SESSION = requests.Session()
_PIN_SESSION.headers.update({
    'User-Agent': 'Mozilla/5.0 (compatible; AvSGo/1.0; +https://avsgo.app)',
    'Accept': 'application/json, */*',
    'Connection': 'keep-alive',
})


def _postalpincode_lookup(pincode: str):
    """Real India Post PIN → area/district/state via api.postalpincode.in.
    Highly reliable but blocks the default python-requests UA — we use a browser UA."""
    for attempt in range(3):
        try:
            r = _PIN_SESSION.get(f'https://api.postalpincode.in/pincode/{pincode}', timeout=15)
            r.raise_for_status()
            rows = r.json()
            if not rows or rows[0].get('Status') != 'Success':
                return None
            offices = rows[0].get('PostOffice') or []
            if not offices:
                return None
            ranked = sorted(offices, key=lambda o: {
                'Head Post Office': 0, 'Sub Post Office': 1, 'Branch Post Office': 2,
            }.get(o.get('BranchType', ''), 3))
            first = ranked[0]
            return {
                'area_name': first.get('Name'),
                'district': first.get('District'),
                'state': first.get('State'),
                'country': first.get('Country', 'India'),
                'block': first.get('Block'),
                'office_count': len(offices),
            }
        except Exception as e:
            logger.warning(f'postalpincode.in attempt {attempt+1} for {pincode}: {e}')
            time.sleep(0.5 * (attempt + 1))
    return None


def _nominatim_search(params: dict, retries: int = 2):
    """Nominatim /search with retry. Returns rows or []."""
    for i in range(retries + 1):
        try:
            r = requests.get(
                'https://nominatim.openstreetmap.org/search',
                params=params,
                headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'},
                timeout=15,
            )
            r.raise_for_status()
            data = r.json()
            if data:
                return data
        except Exception as e:
            logger.warning(f'nominatim attempt {i+1} failed: {e}')
        time.sleep(0.6 * (i + 1))
    return []


def _photon_geocode(query: str):
    """Photon forward-geocoding fallback (OSM-backed, no key, less rate-limited than Nominatim).
    Returns (lat, lng, bbox|None) or None."""
    try:
        r = requests.get(
            'https://photon.komoot.io/api',
            params={'q': query, 'limit': 1, 'lang': 'en'},
            headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'},
            timeout=15,
        )
        r.raise_for_status()
        feats = r.json().get('features') or []
        if not feats:
            return None
        f = feats[0]
        coords = (f.get('geometry') or {}).get('coordinates') or []
        if len(coords) < 2:
            return None
        lat, lng = float(coords[1]), float(coords[0])
        ext = (f.get('properties') or {}).get('extent')
        bbox = None
        if ext and len(ext) == 4:
            bbox = {'west': float(ext[0]), 'north': float(ext[1]),
                    'east': float(ext[2]), 'south': float(ext[3])}
        return (lat, lng, bbox)
    except Exception as e:
        logger.warning(f'photon geocode failed: {e}')
        return None


from math import radians, sin, cos, atan2, sqrt


def _haversine_km(lat1, lng1, lat2, lng2):
    R = 6371.0
    d_lat = radians(lat2 - lat1)
    d_lng = radians(lng2 - lng1)
    s = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lng / 2) ** 2
    return R * 2 * atan2(sqrt(s), sqrt(1 - s))


def _wikipedia_geosearch(query: str, lat: float, lng: float, max_km: float = 60.0, limit: int = 5):
    """Real knowledge-base fallback for places OSM hasn't tagged yet
    (e.g. new universities, colleges, hospitals). Only returns Wikipedia
    pages whose primary coordinates are within `max_km` of (lat, lng) so
    the customer never sees a far-away same-named place."""
    try:
        r = requests.get(
            'https://en.wikipedia.org/w/api.php',
            params={'action': 'opensearch', 'search': query, 'limit': 10,
                    'format': 'json', 'namespace': 0, 'redirects': 'resolve'},
            headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        titles = data[1] if len(data) > 1 else []
        if not titles:
            return []
        r2 = requests.get(
            'https://en.wikipedia.org/w/api.php',
            params={'action': 'query', 'titles': '|'.join(titles[:10]),
                    'prop': 'coordinates|extracts', 'exintro': 1, 'explaintext': 1,
                    'exchars': 120, 'format': 'json', 'coprimary': 'primary'},
            headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'},
            timeout=12,
        )
        r2.raise_for_status()
        pages = ((r2.json().get('query') or {}).get('pages') or {}).values()
        hits = []
        for p in pages:
            coords = p.get('coordinates') or []
            if not coords:
                continue
            c = coords[0]
            plat = float(c['lat'])
            plng = float(c['lon'])
            km = _haversine_km(lat, lng, plat, plng)
            if km > max_km:
                continue
            hits.append({
                'title': p.get('title'),
                'summary': (p.get('extract') or '').strip(),
                'lat': plat,
                'lng': plng,
                'km': km,
            })
        hits.sort(key=lambda x: x['km'])
        return hits[:limit]
    except Exception as e:
        logger.warning(f'wikipedia geosearch failed: {e}')
        return []



    try:
        r = requests.get(
            'https://photon.komoot.io/api',
            params={'q': query, 'limit': 1, 'lang': 'en'},
            headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'},
            timeout=15,
        )
        r.raise_for_status()
        feats = r.json().get('features') or []
        if not feats:
            return None
        f = feats[0]
        coords = (f.get('geometry') or {}).get('coordinates') or []
        if len(coords) < 2:
            return None
        lat, lng = float(coords[1]), float(coords[0])
        ext = (f.get('properties') or {}).get('extent')
        bbox = None
        if ext and len(ext) == 4:
            # photon extent order: [minLon, maxLat, maxLon, minLat]
            bbox = {'west': float(ext[0]), 'north': float(ext[1]),
                    'east': float(ext[2]), 'south': float(ext[3])}
        return (lat, lng, bbox)
    except Exception as e:
        logger.warning(f'photon geocode failed: {e}')
        return None



@api_router.get("/pincode/{pincode}")
async def resolve_pincode(pincode: str):
    """Resolve any valid 6-digit Indian PIN → area + coords + bbox using real production APIs.
    Cascade:
      • **api.postalpincode.in** (India Post — reliable metadata)
      • Coordinates: Nominatim postal-code → Photon free-text on postal metadata → Nominatim free-text
    Cached 12 h on success (60 s on failure) so retries don't hammer public APIs.
    """
    if not (pincode.isdigit() and len(pincode) == 6):
        raise HTTPException(400, 'Enter a valid 6-digit Indian PIN code')

    # AvSGo service availability is controlled only by Admin-enabled Pickup PINs.
    service_area = await db.service_areas.find_one({'pickup_pin': pincode, 'enabled': True}, {'_id': 0})
    if not service_area:
        raise HTTPException(403, 'AvSGo service is not available for this Pickup PIN')

    now = time.time()
    cached = _PIN_CACHE.get(pincode)
    if cached and cached[0] > now:
        if isinstance(cached[1], HTTPException):
            raise cached[1]
        return cached[1]

    loop = asyncio.get_event_loop()

    meta = await loop.run_in_executor(None, _postalpincode_lookup, pincode)

    # 1) Nominatim postal-code search
    rows = await loop.run_in_executor(None, _nominatim_search,
        {'postalcode': pincode, 'country': 'India', 'format': 'json', 'limit': 1, 'addressdetails': 1})

    lat = lng = None
    bbox = None
    address = {}
    display_name = None

    if rows:
        x = rows[0]
        lat, lng = float(x['lat']), float(x['lon'])
        bb = x.get('boundingbox') or []
        if len(bb) == 4:
            bbox = {'south': float(bb[0]), 'north': float(bb[1]),
                    'west': float(bb[2]), 'east': float(bb[3])}
        address = x.get('address') or {}
        display_name = x.get('display_name')

    # 2) Photon free-text using india-post metadata (works even when Nominatim is rate-limited)
    if lat is None and meta:
        q_parts = [meta.get('area_name'), meta.get('block'), meta.get('district'), meta.get('state'), 'India']
        q = ', '.join([p for p in q_parts if p])
        got = await loop.run_in_executor(None, _photon_geocode, q)
        if got:
            lat, lng, ext = got
            if ext:
                bbox = {'south': ext['south'], 'north': ext['north'], 'west': ext['west'], 'east': ext['east']}

    # 3) Nominatim free-text on india-post metadata
    if lat is None and meta:
        q_parts = [meta.get('area_name'), meta.get('block'), meta.get('district'), meta.get('state'), 'India']
        q = ', '.join([p for p in q_parts if p])
        rows2 = await loop.run_in_executor(None, _nominatim_search,
            {'q': q, 'format': 'json', 'limit': 1, 'countrycodes': 'in', 'addressdetails': 1})
        if rows2:
            x = rows2[0]
            lat, lng = float(x['lat']), float(x['lon'])
            bb = x.get('boundingbox') or []
            if len(bb) == 4:
                bbox = {'south': float(bb[0]), 'north': float(bb[1]),
                        'west': float(bb[2]), 'east': float(bb[3])}
            address = x.get('address') or {}
            display_name = display_name or x.get('display_name')

    # 4) District-level Photon fallback (still real, but coarser)
    if lat is None and meta and meta.get('district') and meta.get('state'):
        got = await loop.run_in_executor(None, _photon_geocode, f"{meta['district']}, {meta['state']}, India")
        if got:
            lat, lng, ext = got
            if ext:
                bbox = {'south': ext['south'], 'north': ext['north'], 'west': ext['west'], 'east': ext['east']}

    if lat is None:
        if not meta:
            err = HTTPException(404, f'PIN code {pincode} not found. Please check the code and try again.')
            _PIN_CACHE[pincode] = (now + _PIN_CACHE_TTL_FAIL, err)
            raise err
        err = HTTPException(
            503,
            f'PIN {pincode} area is {meta.get("area_name")}, {meta.get("district")}, {meta.get("state")} '
            f'but the map service is temporarily unavailable. Please try again in a moment.',
        )
        _PIN_CACHE[pincode] = (now + _PIN_CACHE_TTL_FAIL, err)
        raise err

    if bbox is None:
        # ~5 km box around the resolved centre — enough for the initial map framing
        bbox = {'south': lat - 0.045, 'north': lat + 0.045, 'west': lng - 0.045, 'east': lng + 0.045}

    if meta:
        parts = [pincode, meta.get('area_name'), meta.get('district'), meta.get('state'), 'India']
        display_name = ', '.join([p for p in parts if p])

    resp = {
        'pincode': pincode,
        'display_name': display_name or f'PIN {pincode}',
        'lat': lat,
        'lng': lng,
        'bbox': bbox,
        'address': address,
        'postal_data': meta,
        'source': ('postalpincode.in+' if meta else '') + ('nominatim' if rows else 'photon'),
    }
    _PIN_CACHE[pincode] = (now + _PIN_CACHE_TTL_OK, resp)
    return resp


@api_router.get("/reverse-geocode")
async def reverse_geocode(lat: float = Query(...), lng: float = Query(...)):
    """Coord → human address via Nominatim (no key). Used by the map picker to display selected address."""
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        raise HTTPException(400, 'Invalid coordinates')
    try:
        r = requests.get(
            'https://nominatim.openstreetmap.org/reverse',
            params={'lat': lat, 'lon': lng, 'format': 'json', 'zoom': 18, 'addressdetails': 0},
            headers={'User-Agent': 'AvSGo/1.0 (admin@avsgo.app)'},
            timeout=12,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.warning(f'reverse-geocode failed: {e}')
        return {'display_name': None, 'lat': lat, 'lng': lng}
    return {'display_name': data.get('display_name'), 'lat': lat, 'lng': lng}


@api_router.post("/route")
async def route(payload: RouteIn):
    """Return real road-distance + polyline geometry + estimated fare between two coordinates.
    Primary: OSRM public router (no API key). Fallback: OpenRouteService when ROUTING_API_KEY is set.
    If both fail, returns HTTP 503 — we never fabricate a distance."""
    for v in (payload.pickup_lat, payload.drop_lat):
        if not (-90 <= v <= 90):
            raise HTTPException(400, 'Invalid latitude')
    for v in (payload.pickup_lng, payload.drop_lng):
        if not (-180 <= v <= 180):
            raise HTTPException(400, 'Invalid longitude')

    loop = asyncio.get_event_loop()
    distance_km = duration_min = geometry = None
    method = None
    last_err = None
    try:
        distance_km, duration_min, geometry = await loop.run_in_executor(
            None, _osrm_route,
            payload.pickup_lat, payload.pickup_lng, payload.drop_lat, payload.drop_lng,
        )
        method = 'osrm'
    except Exception as e:
        last_err = str(e)
        logger.warning(f'OSRM route failed: {e}')
        if ROUTING_API_KEY and ROUTING_PROVIDER == 'ors':
            try:
                distance_km, duration_min, geometry = await loop.run_in_executor(
                    None, _ors_route,
                    payload.pickup_lat, payload.pickup_lng, payload.drop_lat, payload.drop_lng,
                )
                method = 'ors'
            except Exception as e2:
                last_err = str(e2)
                logger.warning(f'ORS route failed: {e2}')

    if method is None or not distance_km:
        raise HTTPException(
            503,
            'Routing service is temporarily unavailable. Please try again in a moment.',
        )

    resp = {
        'distance_km': distance_km,
        'duration_min': duration_min,
        'method': method,
        'geometry': geometry,
    }
    if payload.vehicle_type:
        if payload.vehicle_type not in VEHICLE_TYPES:
            raise HTTPException(400, 'Invalid vehicle type')
        cfg = await db.fare_settings.find_one({'vehicle_type': payload.vehicle_type})
        if cfg:
            base = float(cfg['base_fare'])
            per_km = float(cfg['per_km'])
            resp.update({
                'vehicle_type': payload.vehicle_type,
                'base_fare': base,
                'per_km': per_km,
                'fare': round(base + per_km * distance_km, 2),
            })
    return resp



class ReviewPaymentIn(BaseModel):
    action: Literal['approve', 'reject']
    note: Optional[str] = None



class PaymentSettingsIn(BaseModel):
    upi_id: Optional[str] = None
    qr_file_id: Optional[str] = None
    active: bool = True

class ManagerPayoutCreate(BaseModel):
    manager_id: str
    amount: float
    receipt_file_id: Optional[str] = None
    note: Optional[str] = None


@api_router.get("/admin/manager-payouts")
async def admin_manager_payouts(_=Depends(require_admin)):
    cur = db.manager_payouts.find({}, {'_id': 0}).sort('created_at', -1)
    return await cur.to_list(1000)

@api_router.get("/admin/managers/{manager_id}/commission-summary")
async def admin_manager_commission_summary(manager_id: str, _=Depends(require_admin)):
    manager = await db.managers.find_one({'id': manager_id}, {'_id': 0, 'id': 1, 'name': 1, 'commission_pct': 1, 'pickup_pins': 1})
    if not manager:
        raise HTTPException(404, 'Manager not found')
    pins = manager.get('pickup_pins') or []
    q = {'pickup_pin': {'$in': pins}, 'status': 'completed'} if pins else {'pickup_pin': '__none__'}
    agg = await db.bookings.aggregate([{'$match': q}, {'$group': {'_id': None, 'admin_commission': {'$sum': '$commission'}}}]).to_list(1)
    admin_commission = round(float(agg[0].get('admin_commission', 0)) if agg else 0, 2)
    earned = round(admin_commission * float(manager.get('commission_pct', 10)) / 100, 2)
    paidagg = await db.manager_payouts.aggregate([{'$match': {'manager_id': manager_id, 'status': 'completed'}}, {'$group': {'_id': None, 'paid': {'$sum': '$amount'}}}]).to_list(1)
    paid = round(float(paidagg[0].get('paid', 0)) if paidagg else 0, 2)
    return {'manager_id': manager_id, 'manager_name': manager.get('name'), 'commission_pct': manager.get('commission_pct', 10), 'admin_commission': admin_commission, 'earned': earned, 'paid': paid, 'remaining': round(max(0, earned - paid), 2)}

@api_router.post("/admin/manager-payouts")
async def admin_manager_payout(payload: ManagerPayoutCreate, _=Depends(require_admin)):
    if payload.amount <= 0: raise HTTPException(400, 'Amount must be greater than 0')
    manager = await db.managers.find_one({'id': payload.manager_id})
    if not manager: raise HTTPException(404, 'Manager not found')
    agg = await db.bookings.aggregate([
        {'$match': {'pickup_pin': {'$in': manager.get('pickup_pins') or []}, 'status':'completed'}},
        {'$group': {'_id':None, 'admin_commission': {'$sum':'$commission'}}}
    ]).to_list(1)
    admin_commission=float(agg[0].get('admin_commission',0)) if agg else 0
    earned=round(admin_commission*float(manager.get('commission_pct',10))/100,2)
    paidagg=await db.manager_payouts.aggregate([
        {'$match': {'manager_id':payload.manager_id,'status':'completed'}},
        {'$group': {'_id':None,'paid':{'$sum':'$amount'}}}
    ]).to_list(1)
    paid=float(paidagg[0].get('paid',0)) if paidagg else 0
    if payload.amount > max(0, earned-paid)+0.005:
        raise HTTPException(400, f'Amount exceeds remaining manager balance ₹{max(0,earned-paid):.2f}')
    doc={'id':str(uuid.uuid4()),'manager_id':payload.manager_id,'manager_name':manager.get('name'),
         'amount':round(payload.amount,2),'receipt_file_id':payload.receipt_file_id,'note':payload.note,
         'status':'completed','created_at':now_iso(),'paid_at':now_iso()}
    await db.manager_payouts.insert_one(doc); doc.pop('_id',None)
    return doc

@api_router.get("/manager/payouts")
async def manager_payouts(manager=Depends(require_manager)):
    if not manager_can(manager, 'payments', 'view'):
        raise HTTPException(403, 'Payments view permission is OFF')
    cur = db.manager_payouts.find({'manager_id': manager['id']}, {'_id': 0}).sort('created_at', -1)
    return await cur.to_list(500)

@api_router.get("/drop-places")
async def public_drop_places():
    cur = db.drop_places.find({'enabled': True}, {'_id': 0}).sort('place_name', 1)
    return await cur.to_list(10000)


@api_router.post("/admin/drop-places")
async def admin_add_drop_place(payload: DropPlaceCreate, _=Depends(require_admin)):
    name = payload.place_name.strip()
    if not name:
        raise HTTPException(400, 'Place name is required')
    doc = {'id': str(uuid.uuid4()), 'place_name': name, 'latitude': payload.latitude, 'longitude': payload.longitude,
           'pickup_pin': payload.pickup_pin, 'enabled': payload.enabled, 'added_by_type': 'admin', 'added_by_id': 'admin', 'created_at': now_iso(), 'updated_at': now_iso()}
    await db.drop_places.insert_one(doc)
    doc.pop('_id', None)
    return doc


@api_router.get("/admin/drop-places")
async def admin_drop_places(_=Depends(require_admin)):
    cur = db.drop_places.find({}, {'_id': 0}).sort('created_at', -1)
    return await cur.to_list(10000)


@api_router.patch("/admin/drop-places/{place_id}")
async def admin_update_drop_place(place_id: str, payload: DropPlaceAction, _=Depends(require_admin)):
    update = {}
    if payload.enabled is not None: update['enabled'] = payload.enabled
    if payload.place_name is not None: update['place_name'] = payload.place_name.strip()
    if not update: raise HTTPException(400, 'Nothing to update')
    update['updated_at'] = now_iso()
    r = await db.drop_places.update_one({'id': place_id}, {'$set': update})
    if not r.matched_count: raise HTTPException(404, 'Drop place not found')
    return await db.drop_places.find_one({'id': place_id}, {'_id': 0})


@api_router.get("/payment-settings/{owner_type}/{owner_id}")
async def get_payment_settings(owner_type: str, owner_id: str):
    if owner_type not in ('admin', 'manager', 'driver'):
        raise HTTPException(400, 'Invalid owner type')
    rec = await db.payment_settings.find_one({'owner_type': owner_type, 'owner_id': owner_id, 'active': True}, {'_id': 0})
    return rec or {'owner_type': owner_type, 'owner_id': owner_id, 'upi_id': None, 'qr_file_id': None, 'active': False}


@api_router.put("/payment-settings/{owner_type}/{owner_id}")
async def save_payment_settings(owner_type: str, owner_id: str, payload: PaymentSettingsIn, user=Depends(get_current)):
    if owner_type not in ('admin', 'manager', 'driver'):
        raise HTTPException(400, 'Invalid owner type')
    if owner_type != user.get('role') or (owner_type != 'admin' and owner_id != user.get('sub')):
        raise HTTPException(403, 'Only the owner can edit payment settings')
    doc = {'owner_type': owner_type, 'owner_id': owner_id, 'upi_id': (payload.upi_id or '').strip() or None, 'qr_file_id': payload.qr_file_id, 'active': payload.active, 'updated_at': now_iso()}
    await db.payment_settings.update_one({'owner_type': owner_type, 'owner_id': owner_id}, {'$set': doc, '$setOnInsert': {'created_at': now_iso()}}, upsert=True)
    return doc


@api_router.get('/admin/payment-settings')
async def admin_payment_settings(_=Depends(require_admin)):
    rec=await db.payment_settings.find_one({'owner_type':'admin','owner_id':'admin'},{'_id':0})
    return rec or {'owner_type':'admin','owner_id':'admin','upi_id':ADMIN_UPI,'qr_file_id':None,'active':True}

@api_router.put('/admin/payment-settings')
async def admin_save_payment_settings(payload: PaymentSettingsIn, _=Depends(require_admin)):
    doc={'owner_type':'admin','owner_id':'admin','upi_id':(payload.upi_id or '').strip() or None,'qr_file_id':payload.qr_file_id,'active':payload.active,'updated_at':now_iso()}
    await db.payment_settings.update_one({'owner_type':'admin','owner_id':'admin'},{'$set':doc,'$setOnInsert':{'created_at':now_iso()}},upsert=True)
    return doc

@api_router.get('/admin/manager-payment-settings/{manager_id}')
async def admin_manager_payment_settings(manager_id: str, _=Depends(require_admin)):
    manager = await db.managers.find_one({'id': manager_id}, {'_id': 0, 'id': 1, 'name': 1, 'manager_id': 1})
    if not manager:
        raise HTTPException(404, 'Manager not found')
    rec = await db.payment_settings.find_one({'owner_type': 'manager', 'owner_id': manager_id, 'active': True}, {'_id': 0})
    return {'manager': manager, 'payment': rec or {'owner_type': 'manager', 'owner_id': manager_id, 'upi_id': None, 'qr_file_id': None, 'active': False}}

@api_router.get('/upi')
async def public_upi():
    rec=await db.payment_settings.find_one({'owner_type':'admin','owner_id':'admin','active':True},{'_id':0})
    if rec:
        qr=('/api/files/'+rec['qr_file_id']) if rec.get('qr_file_id') else '/upi-qr.jpeg'
        return {'upi':rec.get('upi_id') or ADMIN_UPI,'qr_url':qr}
    return {'upi':ADMIN_UPI,'qr_url':'/upi-qr.jpeg'}


@api_router.post("/driver/commission-payments")
async def submit_commission_payment(payload: PayCommissionIn, user=Depends(require_driver)):
    if payload.amount <= 0:
        raise HTTPException(400, 'Amount must be greater than 0')
    utr = (payload.utr or '').strip()
    if len(utr) < 6:
        raise HTTPException(400, 'Enter a valid UTR / Transaction ID (min 6 chars)')
    driver = await db.drivers.find_one({'id': user['sub']})
    if not driver:
        raise HTTPException(404, 'Driver not found')
    doc = {
        'id': str(uuid.uuid4()),
        'driver_id': user['sub'],
        'driver_name': driver.get('name'),
        'driver_mobile': driver.get('mobile'),
        'amount': round(payload.amount, 2),
        'utr': utr,
        'status': 'pending',
        'submitted_at': now_iso(),
        'reviewed_at': None,
        'note': None,
        'applied_amount': 0,
        'applied_bookings': [],
    }
    await db.commission_payments.insert_one(doc)
    doc.pop('_id', None)
    await send_push(
        'admin',
        'Commission payment submitted',
        f"{driver.get('name')} submitted ₹{doc['amount']} (UTR {utr}). Please verify.",
        {'url': '/admin', 'type': 'commission_payment_pending'},
    )
    return doc


@api_router.get("/driver/commission-payments")
async def list_my_payments(user=Depends(require_driver)):
    cur = db.commission_payments.find({'driver_id': user['sub']}, {'_id': 0}).sort('submitted_at', -1)
    return await cur.to_list(200)


@api_router.get("/admin/commission-payments")
async def admin_list_payments(status: Optional[str] = None, _=Depends(require_admin)):
    q = {}
    if status:
        q['status'] = status
    cur = db.commission_payments.find(q, {'_id': 0}).sort('submitted_at', -1)
    return await cur.to_list(500)


@api_router.patch("/admin/commission-payments/{payment_id}")
async def review_payment(payment_id: str, payload: ReviewPaymentIn, _=Depends(require_admin)):
    p = await db.commission_payments.find_one({'id': payment_id})
    if not p:
        raise HTTPException(404, 'Payment not found')
    if p['status'] != 'pending':
        raise HTTPException(400, f"Payment already {p['status']}")

    if payload.action == 'reject':
        await db.commission_payments.update_one(
            {'id': payment_id},
            {'$set': {'status': 'rejected', 'reviewed_at': now_iso(), 'note': payload.note}},
        )
        await send_push(
            f"driver:{p['driver_id']}",
            'Commission payment rejected',
            payload.note or f"Your ₹{p['amount']} payment (UTR {p['utr']}) was rejected. Please recheck and resubmit.",
            {'url': '/driver', 'type': 'commission_payment_rejected'},
        )
        return {'id': payment_id, 'status': 'rejected'}

    # Approve: mark oldest unpaid bookings until paid amount is exhausted (partial-friendly).
    unpaid = await db.bookings.find(
        {'driver_id': p['driver_id'], 'status': 'completed', 'commission_paid': {'$ne': True}},
        {'_id': 0, 'id': 1, 'commission': 1},
    ).sort('created_at', 1).to_list(1000)
    remaining = float(p['amount'])
    applied_ids: List[str] = []
    applied_sum = 0.0
    for bk in unpaid:
        c = float(bk.get('commission') or 0)
        if c <= 0:
            continue
        if c <= remaining + 0.005:
            applied_ids.append(bk['id'])
            applied_sum += c
            remaining -= c
        else:
            break
    if applied_ids:
        await db.bookings.update_many(
            {'id': {'$in': applied_ids}},
            {'$set': {'commission_paid': True, 'commission_paid_at': now_iso(), 'commission_payment_id': payment_id}},
        )
    await db.commission_payments.update_one(
        {'id': payment_id},
        {'$set': {
            'status': 'approved',
            'reviewed_at': now_iso(),
            'note': payload.note,
            'applied_amount': round(applied_sum, 2),
            'applied_bookings': applied_ids,
        }},
    )
    await send_push(
        f"driver:{p['driver_id']}",
        'Commission payment approved',
        f"Admin approved ₹{p['amount']}. ₹{round(applied_sum,2)} applied to {len(applied_ids)} trip(s).",
        {'url': '/driver', 'type': 'commission_payment_approved'},
    )
    return {'id': payment_id, 'status': 'approved', 'applied_amount': round(applied_sum, 2), 'applied_bookings': applied_ids}


# ---- Legacy admin settle (kept for backwards compat) ----
@api_router.post("/admin/drivers/{driver_id}/settle-commission")
async def settle_commission(driver_id: str, _=Depends(require_admin)):
    driver = await db.drivers.find_one({'id': driver_id})
    if not driver:
        raise HTTPException(404, 'Driver not found')
    pipeline = [
        {'$match': {'driver_id': driver_id, 'status': 'completed', 'commission_paid': {'$ne': True}}},
        {'$group': {'_id': None, 'total': {'$sum': '$commission'}, 'count': {'$sum': 1}}},
    ]
    agg = await db.bookings.aggregate(pipeline).to_list(1)
    if not agg or agg[0]['count'] == 0:
        raise HTTPException(400, 'No pending commission to settle')
    amount = round(agg[0]['total'], 2)
    count = agg[0]['count']
    paid_at = now_iso()
    await db.bookings.update_many(
        {'driver_id': driver_id, 'status': 'completed', 'commission_paid': {'$ne': True}},
        {'$set': {'commission_paid': True, 'commission_paid_at': paid_at}},
    )
    payout = {
        'id': str(uuid.uuid4()),
        'driver_id': driver_id,
        'driver_name': driver.get('name'),
        'amount': amount,
        'trips': count,
        'paid_at': paid_at,
    }
    await db.payouts.insert_one(payout.copy())
    payout.pop('_id', None)
    await send_push(
        f"driver:{driver_id}",
        'Commission cleared',
        f"Admin marked ₹{amount} commission ({count} trip{'s' if count != 1 else ''}) as paid. Thank you!",
        {'url': '/driver', 'type': 'commission_paid'},
    )
    return {'ok': True, 'amount': amount, 'trips': count, 'payout_id': payout['id']}


@api_router.get("/admin/drivers/{driver_id}/payouts")
async def list_payouts(driver_id: str, _=Depends(require_admin)):
    cur = db.payouts.find({'driver_id': driver_id}, {'_id': 0}).sort('paid_at', -1)
    return await cur.to_list(200)


@api_router.patch("/admin/drivers/{driver_id}/approval")
async def admin_driver_approval(driver_id: str, payload: VehicleAction, _=Depends(require_admin)):
    driver = await db.drivers.find_one({'id': driver_id})
    if not driver: raise HTTPException(404, 'Driver not found')
    approved = payload.action == 'approve'
    await db.drivers.update_one({'id': driver_id}, {'$set': {'approved': approved, 'active': approved, 'approval_updated_at': now_iso()}})
    return await db.drivers.find_one({'id': driver_id}, {'_id': 0, 'password_hash': 0})

# ---- Admin stats ----
@api_router.get("/admin/stats")
async def admin_stats(_=Depends(require_admin)):
    drivers = await db.drivers.count_documents({})
    pending_vehicles = await db.vehicles.count_documents({'status': 'pending'})
    approved_vehicles = await db.vehicles.count_documents({'status': 'approved'})
    total_bookings = await db.bookings.count_documents({})
    completed = await db.bookings.count_documents({'status': 'completed'})
    pipeline = [
        {'$match': {'status': 'completed'}},
        {'$group': {'_id': None, 'revenue': {'$sum': '$fare'}, 'commission': {'$sum': '$commission'}}},
    ]
    agg = await db.bookings.aggregate(pipeline).to_list(1)
    return {
        'drivers': drivers,
        'pending_vehicles': pending_vehicles,
        'approved_vehicles': approved_vehicles,
        'total_bookings': total_bookings,
        'completed_trips': completed,
        'revenue': round(agg[0]['revenue'], 2) if agg else 0,
        'commission_earned': round(agg[0]['commission'], 2) if agg else 0,
        'upi': ADMIN_UPI,
    }


# Include the router
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
