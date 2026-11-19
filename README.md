# Randomness

Hai cách sinh số ngẫu nhiên cho contract trên EVM, độc lập với nhau:

| | `RandomnessOracle` | `RandomnessBeacon` |
|---|---|---|
| **Cách hoạt động** | Node off-chain ký yêu cầu bằng BLS, contract tự kiểm tra chữ ký | Nhiều bên commit rồi reveal secret |
| **Người dùng phải làm** | Gửi một yêu cầu rồi chờ | Đặt cọc, commit, quay lại reveal đúng hạn |
| **Phải tin ai** | Operator không giấu kết quả | Ít nhất một người tham gia giữ kín secret |
| **Hợp với** | App có người dùng đơn lẻ | Nhóm có sẵn động lực tham gia |

# Oracle

## Luồng

1. Contract gọi `requestRandomness()` kèm đúng `fee`.
2. Node thấy event và ký `keccak256(chainId, oracle, requestId, consumer, blockhash(block chứa yêu cầu))`.
3. Node, hoặc bất kỳ ai có chữ ký, gọi `fulfill(requestId, signature)`. Contract kiểm tra bằng pairing rồi lấy `keccak256(signature)` làm kết quả.
4. Oracle gọi `onRandomness(requestId, randomness)` trên contract yêu cầu, với 200.000 gas.

Mỗi thông điệp chỉ có đúng một chữ ký hợp lệ với một key, nên operator không tạo được nhiều kết quả để chọn. Đó là lý do dùng BLS mà không dùng ECDSA.

## Kết quả và tiền phí

| Tình huống | Kết quả | Tiền phí |
|---|---|---|
| Trả lời trong 256 block | Có số ngẫu nhiên, kể cả khi callback lỗi | Thuộc operator, rút bằng `withdraw()` |
| Quá 256 block | Ai cũng gọi được `expire()`, không còn trả lời được | Ghi có cho contract yêu cầu, rút bằng `withdrawRefund()` |

Giới hạn 256 block đến từ `BLOCKHASH`. Avalanche chỉ tạo block khi có giao dịch, nên thời gian thực của cửa sổ này không cố định.

## Mô hình an toàn

**Oracle bảo đảm:**

- Operator không làm giả được kết quả, và không đổi được key. Muốn key mới phải deploy contract mới.
- Người gửi `fulfill` không cố ý làm callback lỗi bằng cách gửi thiếu gas được, vì contract sẽ revert cả giao dịch.

**Oracle không bảo đảm:**

- **Operator giấu kết quả:** operator tính được kết quả trước, nếu bất lợi thì có thể không trả lời. Đây là điểm yếu lớn nhất của bản một node. Muốn giải quyết phải chia key cho nhiều node (threshold BLS) và phạt cọc, phần này chưa làm.
- **Lộ key:** ai có key đoán trước được mọi kết quả.
- **Operator thông đồng với người tạo block:** họ có thể thử nhiều block, xem chữ ký của từng block rồi chọn block có lợi.
- **Node ngừng chạy:** yêu cầu hết hạn sau 256 block.
- **Phí không đủ gas:** phí là cố định, nên operator chịu lỗ khi giá gas tăng. Đặt `fee` cao hơn chi phí tối đa của một lần `fulfill`.
- **Độ an toàn của BN254:** khoảng 100 bit, thấp hơn mức 128 bit thường dùng.
- Contract chưa được audit.

## Viết contract dùng oracle

Xem mẫu ở `src/examples/DiceRoller.sol`. Có 3 quy tắc:

1. **Callback chỉ lưu kết quả,** kiểm tra `msg.sender` là oracle, và không làm việc gì có thể lỗi.
2. **Có đường dự phòng:** callback có thể thất bại, nên cần một hàm công khai đọc `randomnessOf` để hoàn tất.
3. **Không tự rút lại sau khi hết hạn:** chỉ hoàn tiền. Nếu tự rút lại, operator đang giấu kết quả sẽ có thêm một lần thử.

## Chạy

Cần Foundry và Node 22 trở lên.

```sh
./scripts/oracle-demo.sh      # chain local, deploy, chạy node, roll 3 lần
./scripts/fuji-smoke.sh       # kiểm tra contract trên Fuji bằng eth_call, không tốn phí
```

Trên Fuji, nhanh nhất là dùng hai script. Cần file `.env` có khóa BLS (`npm run keygen` trong `node/`) và `FUJI_KEY`, một ví có AVAX test:

```sh
./scripts/fuji-deploy.sh      # deploy oracle, xúc xắc, beacon; ghi địa chỉ vào .env và dashboard/.env.local
./scripts/fuji-node.sh        # chạy node trả lời yêu cầu trên Fuji
```

Làm tay thì cần hai ví có AVAX test: một để deploy, một để node trả phí gas.

```sh
(cd node && npm ci)
(cd node && npm run --silent keygen) > .env   # git bỏ qua file này, giữ kín ORACLE_BLS_KEY
set -a; source .env; set +a
export ORACLE_OPERATOR=<địa chỉ nhận phí> ORACLE_FEE=<phí, tính bằng wei>
forge script script/DeployOracle.s.sol --rpc-url https://api.avax-test.network/ext/bc/C/rpc \
  --private-key <KEY_DEPLOY> --broadcast

cd node
RPC_URL=https://api.avax-test.network/ext/bc/C/rpc ORACLE_ADDRESS=<địa chỉ oracle> ORACLE_TX_KEY=<KEY_NODE> npm start
```

Node không lưu trạng thái: mỗi lần chạy nó đọc lại 256 block gần nhất. Nếu lần chạy trước còn giao dịch kẹt, node thay chúng khi khởi động rồi trả lời lại. Giao dịch kẹt được tăng phí dần, không vượt `MAX_FEE_GWEI` (mặc định 500).

# Beacon

Commit-reveal nhiều bên, có đặt cọc. Không phụ thuộc dịch vụ ngoài, nên chạy được trên mọi EVM chain.

## Luồng

1. **Tạo vòng:** `createRound(commitDuration, revealDuration, bond, minParticipants)`, với `minParticipants >= 2` và `bond > 0`.
2. **Commit:** mỗi người chọn một secret và gọi `commit(roundId, commitment)` kèm đúng số tiền cọc, với:
   ```solidity
   commitment = keccak256(abi.encode(block.chainid, address(beacon), roundId, msg.sender, secret))
   ```
3. **Reveal:** sau khi hết hạn commit, mỗi người gọi `reveal(roundId, secret)`.
4. **Finalize:** sau khi hết hạn commit, ai cũng gọi được `finalize(roundId)` khi tất cả đã reveal hoặc khi đã hết hạn reveal.
5. **Đọc kết quả:** `randomOf(roundId)` trả về số ngẫu nhiên, và revert nếu vòng chưa xong hoặc đã thất bại.
6. **Nhận lại tiền:** `claim(roundId)`.

## Kết quả và tiền cọc

| Tình huống | Kết quả | Tiền cọc |
|---|---|---|
| Đủ người, tất cả reveal | Có số ngẫu nhiên | Hoàn cọc |
| Đủ người, có người không reveal | Vòng thất bại | Người đã reveal được hoàn cọc, người không reveal mất cọc |
| Không đủ `minParticipants` | Vòng thất bại | Hoàn cọc cho mọi người |

Cọc bị mất nằm khóa vĩnh viễn trong contract, không ai rút được. Nếu chia cho người đã reveal hoặc người tạo vòng, kẻ tấn công dùng nhiều địa chỉ có thể lấy lại phần lớn số cọc đó, và việc hủy vòng sẽ gần như miễn phí.

## Mô hình an toàn

- **Không đoán trước được** miễn là có ít nhất một người tham gia giữ kín secret đến pha reveal. Nếu mọi người tham gia đều thông đồng, họ quyết định được kết quả.
- **Người reveal cuối vẫn có một quyền:** họ thấy trước kết quả rồi có thể không reveal để hủy vòng, đổi lại mất cọc. Họ không chọn được kết quả khác trong cùng vòng, nhưng app chạy lại vòng mới thì họ có thêm một lần thử. Vì vậy **cọc phải lớn hơn giá trị có thể thắng được nhờ hủy vòng**.
- **Một người có thể tham gia bằng nhiều địa chỉ.** Việc đó không làm giảm chi phí hủy vòng, nhưng nếu mọi địa chỉ đều thuộc cùng một người thì người đó quyết định được kết quả. App cần tự quyết định ai được tham gia.
- Contract chưa được audit.

# Dashboard

Theo dõi oracle và beacon: băng block, tường entropy vẽ từ chính các số ngẫu nhiên, độ trễ, phân bố xúc xắc và tiến độ từng vòng beacon. Trang đọc thẳng từ RPC, không cần backend hay indexer.

Bấm vào một yêu cầu rồi chọn **Kiểm tra chữ ký BLS**: trình duyệt tự tính lại phép kiểm tra của contract, không cần tin operator. Dữ liệu đầu vào vẫn lấy từ RPC đang kết nối. Câu trả lời gửi qua một contract trung gian thì không đọc được chữ ký, vì chữ ký chỉ nằm trong calldata.

```sh
./scripts/dashboard-demo.sh   # chain local có sẵn dữ liệu mẫu, mở http://127.0.0.1:5173
FORK=fuji ./scripts/dashboard-demo.sh   # như trên, nhưng chạy trên bản sao Fuji tại máy: miễn phí, không gửi gì lên Fuji
```

Với contract đã deploy, ví dụ trên Fuji:

```sh
cd dashboard
cp .env.example .env.local    # điền RPC và địa chỉ contract, bỏ trống contract chưa deploy
npm ci && npm run dev
```

## Các khu chức năng

| Khu | Dành cho | Làm được gì |
|---|---|---|
| **Oracle** | Mọi người | Xem số liệu, tìm yêu cầu, tự kiểm chứng, roll (cần đăng nhập) |
| **Beacon** | Mọi người | Xem các vòng; tạo vòng, commit, reveal, finalize, nhận lại cọc (cần đăng nhập) |
| **Tài khoản** | Ví đã đăng nhập | Lượt roll của mình, hoàn tất lượt có callback lỗi, nhận lại phí, các vòng đã tham gia |
| **Developer** | Mọi người | Theo dõi contract của mình, code tích hợp mẫu, lệnh gọi thử |
| **Admin** | Ví operator | Rút phí, đóng yêu cầu quá hạn, chi phí và lãi mỗi câu trả lời, ví node, đối soát, cảnh báo |

## Đăng nhập

Đăng nhập bằng ví: ví ký một tin nhắn để xác nhận là chủ địa chỉ, không tốn phí. Trên anvil, trang liệt kê sẵn các tài khoản dev của node, không cần ví trình duyệt. Ví trùng với `operator` của oracle sẽ vào được Admin.

Trang không có backend, nên đăng nhập chỉ quyết định giao diện hiển thị gì và không bảo vệ dữ liệu: mọi số liệu đều công khai trên chain. Quyền thật do contract kiểm tra khi gửi giao dịch.

Secret của Beacon được sinh và lưu trong `localStorage` của trình duyệt, trước khi gửi commit. Mất secret trước khi reveal là mất cọc, nên trang có nút hiện secret để sao lưu. Ai đọc được `localStorage` của trang cũng đọc được secret.

Trang chỉ đọc 200 yêu cầu và 50 vòng gần nhất, nên thống kê tính trên phạm vi đó. Đối soát chỉ chạy khi đã đọc đủ mọi yêu cầu.

Tình trạng node chỉ là suy luận từ dữ liệu on-chain: node không báo cáo về đâu cả, nên dashboard chỉ biết node có vấn đề khi đã có yêu cầu bị chờ.

# Build và test

```sh
git submodule update --init --recursive
forge test
(cd node && npm ci && npm test && npm run typecheck)
(cd dashboard && npm ci && npm test && npm run build)   # test của dashboard dùng code ký trong node/
```

`test/fixtures/bls.json` do `node/scripts/gen-fixture.ts` sinh ra. Contract và node đều kiểm tra theo file này, nên hai bên phải cho cùng kết quả.

## Deploy Beacon

```sh
forge script script/Deploy.s.sol --rpc-url <RPC_URL> --private-key <KEY> --broadcast
```
