// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./IExtendedResolver.sol";
import "./SignatureVerifier.sol";

interface IResolverService {
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view returns (bytes memory result, uint64 expires, bytes memory sig);
}

contract OffchainResolver is IExtendedResolver {
    bytes4 private constant INTERFACE_ID_ERC165 = 0x01ffc9a7;
    bytes4 private constant INTERFACE_ID_EXTENDED_RESOLVER = 0x9061b923;
    bytes4 private constant INTERFACE_ID_ADDR = 0x3b3b57de;
    bytes4 private constant INTERFACE_ID_ADDR_MULTICOIN = 0xf1cb7e06;
    bytes4 private constant INTERFACE_ID_TEXT = 0x59d1d43c;
    bytes4 private constant INTERFACE_ID_CONTENTHASH = 0xbc1c58d1;

    bytes4 private constant SELECTOR_ADDR = bytes4(keccak256("addr(bytes32)"));
    bytes4 private constant SELECTOR_ADDR_MULTICOIN = bytes4(keccak256("addr(bytes32,uint256)"));
    bytes4 private constant SELECTOR_TEXT = bytes4(keccak256("text(bytes32,string)"));
    bytes4 private constant SELECTOR_CONTENTHASH = bytes4(keccak256("contenthash(bytes32)"));

    string public url;
    mapping(address => bool) public signers;

    event NewSigners(address[] signers);
    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );

    constructor(string memory _url, address[] memory _signers) {
        url = _url;
        for (uint256 i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
        }
        emit NewSigners(_signers);
    }

    function makeSignatureHash(
        address target,
        uint64 expires,
        bytes memory request,
        bytes memory result
    ) external pure returns (bytes32) {
        return SignatureVerifier.makeSignatureHash(target, expires, request, result);
    }

    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view override returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(IResolverService.resolve.selector, name, data);
        _revertOffchainLookup(callData, OffchainResolver.resolveWithProof.selector);
    }

    function addr(bytes32 node) external view returns (address) {
        bytes memory callData = abi.encodeWithSelector(SELECTOR_ADDR, node);
        _revertOffchainLookup(callData, OffchainResolver.addrWithProof.selector);
    }

    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(SELECTOR_ADDR_MULTICOIN, node, coinType);
        _revertOffchainLookup(callData, OffchainResolver.addrBytesWithProof.selector);
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        bytes memory callData = abi.encodeWithSelector(SELECTOR_TEXT, node, key);
        _revertOffchainLookup(callData, OffchainResolver.textWithProof.selector);
    }

    function contenthash(bytes32 node) external view returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(SELECTOR_CONTENTHASH, node);
        _revertOffchainLookup(callData, OffchainResolver.contenthashWithProof.selector);
    }

    function _revertOffchainLookup(bytes memory callData, bytes4 callback) internal view {
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(
            address(this),
            urls,
            callData,
            callback,
            abi.encode(callData, address(this))
        );
    }

    function resolveWithProof(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "SignatureVerifier: Invalid signature");
        return result;
    }

    function addrWithProof(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (address) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "SignatureVerifier: Invalid signature");
        return abi.decode(result, (address));
    }

    function addrBytesWithProof(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "SignatureVerifier: Invalid signature");
        return abi.decode(result, (bytes));
    }

    function textWithProof(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (string memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "SignatureVerifier: Invalid signature");
        return abi.decode(result, (string));
    }

    function contenthashWithProof(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "SignatureVerifier: Invalid signature");
        return abi.decode(result, (bytes));
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == INTERFACE_ID_ERC165 ||
            interfaceId == INTERFACE_ID_EXTENDED_RESOLVER ||
            interfaceId == INTERFACE_ID_ADDR ||
            interfaceId == INTERFACE_ID_ADDR_MULTICOIN ||
            interfaceId == INTERFACE_ID_TEXT ||
            interfaceId == INTERFACE_ID_CONTENTHASH;
    }
}
