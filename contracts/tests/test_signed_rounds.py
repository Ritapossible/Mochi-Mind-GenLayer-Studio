"""Test the contract's signature verification against real browser signatures.

    python contracts/tests/test_signed_rounds.py

`MochiMindValidator.submit_pick` decides who a round belongs to by recovering an
address from an EIP-191 signature, using a keccak-256 and a secp256k1 recovery
the contract implements itself — GenVM has no ecrecover to call. Hand-rolled
crypto is worth what its vectors are worth, so this runs the contract's own
functions against signatures produced by the game client (`genlayer-js`
`signMessage`, the same call the browser makes) over messages built by the
client's message builder.

The fixtures are regenerated with:

    pnpm --filter @workspace/scripts sign-vectors

Nothing here is deployed. The stub below exists only so the contract module can
be imported outside GenVM; every function under test is plain Python that runs
identically on-chain.
"""

import importlib.util
import json
import sys
import types
from pathlib import Path

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "MochiMindValidator.py"
VECTORS_PATH = Path(__file__).resolve().parent / "round_vectors.json"


# ── A genlayer stub, just enough to import the module ─────────────────────────


class _UserError(Exception):
    def __init__(self, message: str = "") -> None:
        super().__init__(message)
        self.message = message


def _passthrough(fn):
    return fn


def _install_genlayer_stub() -> None:
    genlayer = types.ModuleType("genlayer")

    gl = types.SimpleNamespace()
    gl.Contract = type("Contract", (), {})
    gl.public = types.SimpleNamespace(write=_passthrough, view=_passthrough)
    gl.vm = types.SimpleNamespace(
        UserError=_UserError,
        Result=object,
        Return=object,
        run_nondet_unsafe=lambda *_: None,
    )
    gl.nondet = types.SimpleNamespace(
        web=types.SimpleNamespace(get=lambda *_: None),
        exec_prompt=lambda *_, **__: None,
    )
    gl.message = types.SimpleNamespace(sender_address=None)

    genlayer.gl = gl
    genlayer.Address = str
    genlayer.TreeMap = dict
    genlayer.DynArray = list
    genlayer.u256 = int
    genlayer.i256 = int
    genlayer.bigint = int
    # `from genlayer import *` only takes what __all__ lists.
    genlayer.__all__ = [
        "gl", "Address", "TreeMap", "DynArray", "u256", "i256", "bigint",
    ]

    sys.modules["genlayer"] = genlayer


def _load_contract_module():
    _install_genlayer_stub()
    spec = importlib.util.spec_from_file_location("mochimind_contract", CONTRACT_PATH)
    assert spec and spec.loader, f"could not load {CONTRACT_PATH}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── Tests ─────────────────────────────────────────────────────────────────────

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok    {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


def test_keccak(contract) -> None:
    """Keccak-256, not SHA3-256. The two differ only in the padding byte, which
    makes getting it wrong silent until every signature fails to verify."""
    print("keccak-256")
    check(
        "empty string",
        contract._keccak256(b"").hex()
        == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    )
    check(
        "abc",
        contract._keccak256(b"abc").hex()
        == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    )
    # 136 bytes is exactly the rate, so this input needs a whole extra padding
    # block — the case an off-by-one in the padding loop gets wrong. 272 is two
    # full blocks, which exercises absorbing more than once. Both digests come
    # from @noble/hashes, independently of the implementation under test.
    check(
        "one full rate block",
        contract._keccak256(b"a" * 136).hex()
        == "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e",
    )
    check(
        "two full rate blocks",
        contract._keccak256(b"a" * 272).hex()
        == "cf7fcd4f705ee749930d19ca84561a9bf62516bd90a471545fa2f49fdc7e63c8",
    )


def test_message_builder(contract, vectors) -> None:
    """The Python message must match the one the browser signed, byte for byte."""
    print("round message")
    for vector in vectors:
        built = contract._round_message(
            vector["address"],
            vector["stageId"],
            vector["picks"],
            vector["name"],
            vector["nonce"],
        )
        check(
            f"matches client — {vector['description']}",
            built == vector["message"],
            f"\n    built:  {built!r}\n    signed: {vector['message']!r}",
        )


def test_recovery(contract, vectors) -> None:
    """The address the contract recovers must be the one that signed."""
    print("signature recovery")
    for vector in vectors:
        recovered = contract._recover_signer(vector["message"], vector["signature"])
        check(
            f"recovers signer — {vector['description']}",
            recovered == vector["address"],
            f"got {recovered}",
        )


def test_rejections(contract, vectors) -> None:
    """A signature must not survive being altered, truncated, or made malleable."""
    print("rejections")
    vector = vectors[0]
    signature = vector["signature"]
    body = signature[2:]

    check(
        "altered message recovers someone else",
        contract._recover_signer(vector["message"] + " ", signature) != vector["address"],
    )
    check(
        "altered picks recover someone else",
        contract._recover_signer(
            contract._round_message(
                vector["address"], vector["stageId"], ["Pink", "Red"],
                vector["name"], vector["nonce"],
            ),
            signature,
        )
        != vector["address"],
    )
    check(
        "different nonce recovers someone else",
        contract._recover_signer(
            contract._round_message(
                vector["address"], vector["stageId"], vector["picks"],
                vector["name"], vector["nonce"] + 1,
            ),
            signature,
        )
        != vector["address"],
    )
    check("truncated signature", contract._recover_signer(vector["message"], "0xdeadbeef") is None)
    check("empty signature", contract._recover_signer(vector["message"], "") is None)
    check(
        "non-hexadecimal signature",
        contract._recover_signer(vector["message"], "0x" + "z" * 130) is None,
    )

    # Flipping s to n-s and the recovery id gives a second signature that is
    # valid for the same key. Accepting it would let the same round be replayed
    # under a different signature, so low-s is enforced.
    n = contract._SECP256K1_N
    r_hex = body[:64]
    s = int(body[64:128], 16)
    v_hex = body[128:]
    malleable = "0x" + r_hex + format(n - s, "064x") + v_hex
    check("high-s (malleable) variant", contract._recover_signer(vector["message"], malleable) is None)

    # A recovery id outside {0, 1} / {27, 28} is not a signature we made.
    check(
        "invalid recovery id",
        contract._recover_signer(vector["message"], "0x" + body[:128] + "05") is None,
    )


def test_message_injection(contract) -> None:
    """A name cannot forge the fields printed after it.

    `_clean_name` rejects newlines for this reason: without that check a player
    called "x\\nnonce:0" would be signing a message whose nonce line is theirs
    to choose."""
    print("field injection")
    validator = contract.MochiMindValidator.__new__(contract.MochiMindValidator)

    for bad in ("rita\nnonce:0", "rita\rnonce:0", "rita\nname:someone-else"):
        try:
            validator._clean_name(bad)
            check(f"rejects {bad!r}", False, "was accepted")
        except contract.gl.vm.UserError:
            check(f"rejects {bad!r}", True)

    check("accepts a normal name", validator._clean_name("  rita  ") == "rita")

    try:
        validator._clean_options(["Purple", "Whi|te", "Blue"])
        check("rejects '|' in a color name", False, "was accepted")
    except contract.gl.vm.UserError:
        check("rejects '|' in a color name", True)


def main() -> int:
    if not VECTORS_PATH.exists():
        print(f"missing {VECTORS_PATH}")
        print("generate it with:  pnpm --filter @workspace/scripts sign-vectors")
        return 1

    contract = _load_contract_module()
    fixtures = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    vectors = fixtures["vectors"]

    check(
        "signing domain matches the client",
        contract.SIGNING_DOMAIN == fixtures["domain"],
        f"contract {contract.SIGNING_DOMAIN!r} vs client {fixtures['domain']!r}",
    )

    test_keccak(contract)
    test_message_builder(contract, vectors)
    test_recovery(contract, vectors)
    test_rejections(contract, vectors)
    test_message_injection(contract)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
