// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library SignatureVerifier {
    uint256 private constant UPPER_BIT_MASK =
        0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    uint256 private constant SECP256K1N_DIV_2 =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function makeSignatureHash(
        address target,
        uint64 expires,
        bytes memory request,
        bytes memory result
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result))
        );
    }

    function verify(
        bytes calldata request,
        bytes calldata response
    ) internal view returns (address signer, bytes memory result) {
        uint64 expires;
        bytes memory sig;
        (result, expires, sig) = abi.decode(response, (bytes, uint64, bytes));
        (bytes memory extraData, address sender) = abi.decode(request, (bytes, address));
        require(expires >= block.timestamp, "SignatureVerifier: Signature expired");
        signer = recover(makeSignatureHash(sender, expires, extraData, result), sig);
    }

    function recover(bytes32 hash, bytes memory signature) internal pure returns (address) {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            return recover(hash, v, r, s);
        }

        if (signature.length == 64) {
            bytes32 r;
            bytes32 vs;
            assembly {
                r := mload(add(signature, 0x20))
                vs := mload(add(signature, 0x40))
            }
            bytes32 s = bytes32(uint256(vs) & UPPER_BIT_MASK);
            uint8 v = uint8((uint256(vs) >> 255) + 27);
            return recover(hash, v, r, s);
        }

        revert("SignatureVerifier: Invalid signature length");
    }

    function recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        require(uint256(s) <= SECP256K1N_DIV_2, "SignatureVerifier: Invalid signature s");
        require(v == 27 || v == 28, "SignatureVerifier: Invalid signature v");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "SignatureVerifier: Invalid signature");
        return signer;
    }
}
