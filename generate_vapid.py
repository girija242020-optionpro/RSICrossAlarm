"""Generate Web Push VAPID keys for Render environment variables."""
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

key = ec.generate_private_key(ec.SECP256R1())
private_pem = key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)
pub = key.public_key().public_numbers()
public_raw = b'\x04' + pub.x.to_bytes(32, 'big') + pub.y.to_bytes(32, 'big')
public_b64url = base64.urlsafe_b64encode(public_raw).rstrip(b'=').decode()
private_b64 = base64.b64encode(private_pem).decode()
print('Copy these values to Render Environment. Do not publish the private value.')
print('VAPID_PUBLIC_KEY=' + public_b64url)
print('VAPID_PRIVATE_KEY_B64=' + private_b64)
print('VAPID_SUBJECT=mailto:your-email@example.com')
