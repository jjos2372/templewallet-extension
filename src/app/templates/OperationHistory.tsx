import { OpKind } from "@taquito/rpc";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import classNames from "clsx";
import BigNumber from "bignumber.js";
import formatDistanceToNow from "date-fns/formatDistanceToNow";
import { useRetryableSWR } from "lib/swr";
import { TZSTATS_CHAINS } from "lib/tzstats";
import { loadChainId } from "lib/thanos/helpers";
import { T } from "lib/i18n/react";
import {
  BcdPageableTokenTransfers,
  BcdTokenTransfer,
  getTokenTransfers,
  isBcdSupportedNetwork,
} from "lib/better-call-dev";
import {
  getOperations,
  isDelegation,
  isTransaction,
  isTzktSupportedNetwork,
  TzktOperation,
} from "lib/tzkt";
import {
  ThanosAssetType,
  XTZ_ASSET,
  useThanosClient,
  useNetwork,
  useAssets,
  useOnStorageChanged,
  tryParseExpenses,
  tryParseIncomes,
  RawOperationAssetExpense,
  RawOperationAssetIncome,
} from "lib/thanos/front";
import useTippy from "lib/ui/useTippy";
import InUSD from "app/templates/InUSD";
import Identicon from "app/atoms/Identicon";
import HashChip from "app/templates/HashChip";
import Money from "app/atoms/Money";
import { ReactComponent as LayersIcon } from "app/icons/layers.svg";
import { ReactComponent as ArrowRightTopIcon } from "app/icons/arrow-right-top.svg";
import useInfiniteList from "lib/useInfiniteList";
import FormSecondaryButton from "app/atoms/FormSecondaryButton";
import {
  hasReceiver,
  isDelegationOperation,
  isThanosPendingOperation,
  isTokenTransaction,
  isTzktTransaction,
  ThanosHistoricalOperation,
  ThanosHistoricalTokenTransaction,
  ThanosHistoricalTzktOperation,
  ThanosOperation,
  ThanosPendingOperation,
} from "lib/thanos/types";
import HashShortView from "app/atoms/HashShortView";

const PNDOP_EXPIRE_DELAY = 1000 * 60 * 60 * 24;
const TZKT_BASE_URLS = new Map([
  ["NetXdQprcVkpaWU", "https://tzkt.io"],
  ["NetXjD3HPJJjmcd", "https://carthage.tzkt.io"],
  ["NetXm8tYqnMWky1", "https://delphi.tzkt.io"],
]);

type MixedPage = {
  bcd: BcdPageableTokenTransfers;
  tzkt: TzktOperation[];
};

type OperationHistoryProps = {
  accountPkh: string;
  accountOwner?: string;
};

const OperationHistory: React.FC<OperationHistoryProps> = ({
  accountPkh,
  accountOwner,
}) => {
  const { getAllPndOps, removePndOps } = useThanosClient();
  const network = useNetwork();

  /**
   * Pending operations
   */

  const fetchPendingOperations = React.useCallback(async () => {
    const chainId = await loadChainId(network.rpcBaseURL);
    const sendPndOps = await getAllPndOps(accountPkh, chainId);
    const receivePndOps = accountOwner
      ? (await getAllPndOps(accountOwner, chainId)).filter(
          (op) => op.kind === "transaction" && op.destination === accountPkh
        )
      : [];
    return { pndOps: [...sendPndOps, ...receivePndOps], chainId };
  }, [getAllPndOps, network.rpcBaseURL, accountPkh, accountOwner]);

  const pndOpsSWR = useRetryableSWR(
    ["pndops", network.rpcBaseURL, accountPkh, accountOwner],
    fetchPendingOperations,
    { suspense: true, revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  useOnStorageChanged(pndOpsSWR.revalidate);
  const { pndOps, chainId } = pndOpsSWR.data!;

  /**
   * Operation history from TZStats
   */

  const tzStatsNetwork = React.useMemo(
    () => TZSTATS_CHAINS.get(chainId) ?? null,
    [chainId]
  );

  const getKey = useCallback(
    (index: number, previousPageData: MixedPage | null) => {
      if (!previousPageData) {
        return ["mixedOperations", network.id, accountPkh];
      }

      const { bcd, tzkt } = previousPageData;
      if (!bcd.last_id && tzkt.length === 0) {
        return null;
      }

      return [
        "mixedOperations",
        network.id,
        accountPkh,
        bcd.last_id,
        tzkt[tzkt.length - 1]?.id,
      ];
    },
    [network.id, accountPkh]
  );

  const {
    result: mixedOperations,
    error: getOperationsError,
    isLoadingMore,
    isReachingEnd,
    loadMore: loadMoreOperations,
    isRefreshing,
  } = useInfiniteList<
    MixedPage,
    { bcd: BcdTokenTransfer[]; tzkt: TzktOperation[] },
    any[] | null
  >({
    additionalConfig: { refreshInterval: 15000 },
    getDataLength: getDataLength,
    getKey: getKey,
    fetcher: operationsFetcher,
    transformFn: operationsTransformFn,
    itemsPerPage: 20,
    customReachingEnd: operationsReachingEnd,
  });
  console.log(mixedOperations);

  const loadMore = useCallback(() => {
    if (!isReachingEnd) {
      loadMoreOperations();
    }
  }, [isReachingEnd, loadMoreOperations]);

  const operations = useMemo<ThanosHistoricalOperation[]>(() => {
    return [
      ...mixedOperations.bcd.map<ThanosHistoricalTokenTransaction>(
        ({ contract, hash, to, source, amount, status, timestamp }) => ({
          contract: contract,
          hash: hash,
          type: "transaction",
          receiver: to,
          sender: source,
          amount: amount,
          status: status,
          time: timestamp,
          isThanosPending: false,
        })
      ),
      ...mixedOperations.tzkt
        .filter((operation) => {
          if (!isTransaction(operation)) {
            return true;
          }

          return !operation.parameters;
        })
        .map<ThanosHistoricalTzktOperation>((operation) => {
          const {
            bakerFee,
            errors,
            gasLimit,
            gasUsed,
            hash,
            type,
            status,
            sender,
            timestamp,
          } = operation;
          const baseProps = {
            bakerFee,
            errors,
            gasLimit,
            gasUsed,
            hash,
            type,
            status,
            sender: sender.address,
            time: timestamp || new Date().toISOString(),
            isThanosPending: false as const,
          };

          if (isTransaction(operation)) {
            const {
              parameters,
              amount,
              initiator,
              storageFee,
              storageLimit,
              storageUsed,
              allocationFee,
              target,
            } = operation;

            return {
              ...baseProps,
              parameters: parameters,
              amount: amount,
              initiator: initiator,
              storageFee: storageFee,
              storageLimit: storageLimit,
              storageUsed: storageUsed,
              allocationFee: allocationFee,
              receiver: target.address,
              type: "transaction",
            };
          }

          if (isDelegation(operation)) {
            const { amount, initiator, prevDelegate, newDelegate } = operation;

            return {
              ...baseProps,
              amount: amount,
              initiator: initiator,
              prevDelegate: prevDelegate,
              newDelegate: newDelegate,
              type: "delegation",
            };
          }

          return {
            ...baseProps,
            type: "reveal",
          };
        }),
    ];
  }, [mixedOperations]);

  useEffect(() => {
    if (getOperationsError) {
      throw getOperationsError;
    }
  }, [getOperationsError]);

  const pendingOperations = useMemo<ThanosPendingOperation[]>(
    () =>
      pndOps.map((op) => ({
        isThanosPending: true,
        hash: op.hash,
        type: op.kind,
        sender: accountPkh,
        receiver: op.kind === OpKind.TRANSACTION ? op.destination : "",
        amount: +(op.kind === OpKind.TRANSACTION ? op.amount : "0"),
        status: "backtracked",
        parameters: "",
        time: op.addedAt,
      })),
    [pndOps, accountPkh]
  );

  const [uniqueOps, nonUniqueOps] = useMemo(() => {
    const unique: ThanosOperation[] = [];
    const nonUnique: ThanosOperation[] = [];

    for (const pndOp of pendingOperations) {
      const expired =
        new Date(pndOp.time).getTime() + PNDOP_EXPIRE_DELAY < Date.now();

      if (expired || operations.some((op) => opKey(op) === opKey(pndOp))) {
        nonUnique.push(pndOp);
      } else if (unique.every((u) => opKey(u) !== opKey(pndOp))) {
        unique.push(pndOp);
      }
    }

    for (const op of operations) {
      if (unique.every((u) => opKey(u) !== opKey(op))) {
        unique.push(op);
      }
    }

    return [
      unique.sort(
        (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
      ),
      nonUnique,
    ];
  }, [operations, pendingOperations]);

  useEffect(() => {
    if (nonUniqueOps.length > 0) {
      removePndOps(
        accountPkh,
        chainId,
        nonUniqueOps.map((o) => o.hash)
      );
    }
  }, [removePndOps, accountPkh, chainId, nonUniqueOps]);

  const withExplorer = Boolean(tzStatsNetwork);
  const explorerBaseUrl = React.useMemo(
    () => TZKT_BASE_URLS.get(chainId) ?? null,
    [chainId]
  );

  return (
    <div
      className={classNames("mt-8", "w-full max-w-md mx-auto", "flex flex-col")}
    >
      {uniqueOps.length === 0 && (
        <div
          className={classNames(
            "mb-12",
            "flex flex-col items-center justify-center",
            "text-gray-500"
          )}
        >
          <LayersIcon className="w-16 h-auto mb-2 stroke-current" />

          <h3
            className="text-sm font-light text-center"
            style={{ maxWidth: "20rem" }}
          >
            <T id="noOperationsFound" />
          </h3>
        </div>
      )}

      {uniqueOps.map((op) => (
        <Operation
          key={opKey(op)}
          accountPkh={accountPkh}
          withExplorer={withExplorer}
          explorerBaseUrl={explorerBaseUrl}
          operation={op}
        />
      ))}

      {!getOperationsError && (
        <div className="w-full flex justify-center py-4">
          <FormSecondaryButton
            disabled={isRefreshing || isLoadingMore || isReachingEnd}
            loading={isRefreshing || isLoadingMore}
            onClick={loadMore}
          >
            {isReachingEnd ? "There are no more items" : "Load more"}
          </FormSecondaryButton>
        </div>
      )}
    </div>
  );
};

export default OperationHistory;

function getDataLength(pageData: MixedPage) {
  return pageData.bcd.transfers.length + pageData.tzkt.length;
}

function operationsReachingEnd(pageData: MixedPage) {
  return pageData.bcd.transfers.length < 10 && pageData.tzkt.length < 10;
}

async function operationsFetcher(
  _k: string,
  networkId: string,
  accountPkh: string,
  bcdLastId?: string,
  tzktLastId?: string
) {
  return {
    bcd: isBcdSupportedNetwork(networkId)
      ? await getTokenTransfers({
          address: accountPkh,
          network: networkId,
          last_id: bcdLastId,
          size: 10,
        })
      : { transfers: [] },
    tzkt: isTzktSupportedNetwork(networkId)
      ? await getOperations(networkId, {
          address: accountPkh,
          lastId: tzktLastId !== undefined ? Number(tzktLastId) : undefined,
          limit: 10,
        })
      : [],
  };
}

function operationsTransformFn(pagesData: MixedPage[]) {
  return pagesData.reduce<{ bcd: BcdTokenTransfer[]; tzkt: TzktOperation[] }>(
    (acc, pageData) => ({
      bcd: [...acc.bcd, ...pageData.bcd.transfers],
      tzkt: [...acc.tzkt, ...pageData.tzkt],
    }),
    { bcd: [], tzkt: [] }
  );
}

type OperationProps = {
  operation: ThanosOperation;
  accountPkh: string;
  withExplorer: boolean;
  explorerBaseUrl: string | null;
};

const Operation = React.memo<OperationProps>(
  ({ accountPkh, operation, withExplorer, explorerBaseUrl }) => {
    const { expense, income } = useMemo<{
      expense?: RawOperationAssetExpense;
      income?: RawOperationAssetIncome;
    }>(() => {
      if (isThanosPendingOperation(operation)) {
        return {
          expense:
            operation.type === OpKind.TRANSACTION
              ? { amount: new BigNumber(operation.amount) }
              : undefined,
          income: undefined,
        };
      }

      if (isTzktTransaction(operation)) {
        const operations = [
          {
            amount: String(operation.amount),
            kind: operation.type,
            source: operation.sender,
            parameter: operation.parameters && JSON.parse(operation.parameters),
            to: hasReceiver(operation) ? operation.receiver : undefined,
          },
        ];
        return {
          expense: tryParseExpenses(operations, accountPkh)[0]?.expenses?.[0],
          income: tryParseIncomes(operations, accountPkh)[0]?.incomes?.[0],
        };
      }

      if (isTokenTransaction(operation)) {
        const { contract, amount, sender, receiver } = operation;
        const transactionData = {
          tokenAddress: contract,
          amount: new BigNumber(amount),
        };
        const sureImSender = sender === accountPkh;
        const sureImReceiver = receiver === accountPkh;
        return {
          expense:
            sureImSender || (!sureImReceiver && !sender)
              ? transactionData
              : undefined,
          income:
            sureImReceiver || (!sureImSender && !receiver)
              ? transactionData
              : undefined,
        };
      }

      return {
        expense: undefined,
        income: undefined,
      };
    }, [operation, accountPkh]);

    const { hash, type, status, time } = operation;
    const { allAssets } = useAssets();

    const tokenAddress = expense?.tokenAddress || income?.tokenAddress;
    const token = useMemo(
      () =>
        allAssets.find(
          (a) => a.type !== ThanosAssetType.XTZ && a.address === tokenAddress
        ) || null,
      [allAssets, tokenAddress]
    );

    const amount =
      expense?.amount ||
      income?.amount ||
      new BigNumber(
        (isDelegationOperation(operation) && operation.amount) || 0
      );
    const finalVolume = tokenAddress
      ? amount.div(10 ** (token?.decimals || 0))
      : amount.div(1e6).toNumber();

    const volumeExists = finalVolume !== 0;
    const typeTx = type === "transaction";
    const imReceiver = !!income;
    const pending = withExplorer && status === "pending";
    const failed = ["failed", "backtracked", "skipped"].includes(status);

    return useMemo(
      () => (
        <div className={classNames("my-3", "flex items-stretch")}>
          <div className="mr-2">
            <Identicon hash={hash} size={50} className="shadow-xs" />
          </div>

          <div className="flex-1">
            <div className="flex items-center">
              <HashChip
                hash={hash}
                firstCharsCount={10}
                lastCharsCount={7}
                small
                className="mr-2"
              />

              {explorerBaseUrl && (
                <OpenInExplorerChip
                  baseUrl={explorerBaseUrl}
                  opHash={hash}
                  className="mr-2"
                />
              )}

              <div className={classNames("flex-1", "h-px", "bg-gray-200")} />
            </div>

            <div className="flex items-stretch">
              <div className="flex flex-col">
                <span className="mt-1 text-xs text-blue-600 opacity-75">
                  {formatOperationType(type, imReceiver)}
                </span>

                {(() => {
                  const timeNode = (
                    <Time
                      children={() => (
                        <span className="text-xs font-light text-gray-500">
                          {formatDistanceToNow(new Date(time), {
                            includeSeconds: true,
                            addSuffix: true,
                            // @TODO Add dateFnsLocale
                            // locale: dateFnsLocale,
                          })}
                        </span>
                      )}
                    />
                  );

                  switch (true) {
                    case failed:
                      return (
                        <div className="flex items-center">
                          <T id={status}>
                            {(message) => (
                              <span className="mr-1 text-xs font-light text-red-700">
                                {message}
                              </span>
                            )}
                          </T>

                          {timeNode}
                        </div>
                      );

                    case pending:
                      return (
                        <T id="pending">
                          {(message) => (
                            <span className="text-xs font-light text-yellow-600">
                              {message}
                            </span>
                          )}
                        </T>
                      );

                    default:
                      return timeNode;
                  }
                })()}
              </div>

              <div className="flex-1" />

              {volumeExists && !failed && (
                <div className="flex flex-col items-end flex-shrink-0">
                  <div
                    className={classNames(
                      "text-sm",
                      (() => {
                        switch (true) {
                          case pending:
                            return "text-yellow-600";

                          case typeTx:
                            return imReceiver
                              ? "text-green-500"
                              : "text-red-700";

                          default:
                            return "text-gray-800";
                        }
                      })()
                    )}
                  >
                    {typeTx && (imReceiver ? "+" : "-")}
                    <Money>{finalVolume}</Money>{" "}
                    {token ? (
                      token.symbol
                    ) : tokenAddress ? (
                      <>
                        (unknown token <HashShortView hash={tokenAddress} />)
                      </>
                    ) : (
                      "ꜩ"
                    )}
                  </div>

                  <InUSD volume={finalVolume} asset={token || XTZ_ASSET}>
                    {(usdVolume) => (
                      <div className="text-xs text-gray-500">
                        <span className="mr-px">$</span>
                        {usdVolume}
                      </div>
                    )}
                  </InUSD>
                </div>
              )}
            </div>
          </div>
        </div>
      ),
      [
        hash,
        finalVolume,
        imReceiver,
        pending,
        failed,
        status,
        time,
        token,
        tokenAddress,
        type,
        typeTx,
        volumeExists,
        explorerBaseUrl,
      ]
    );
  }
);

type OpenInExplorerChipProps = {
  baseUrl: string;
  opHash: string;
  className?: string;
};

const OpenInExplorerChip: React.FC<OpenInExplorerChipProps> = ({
  baseUrl,
  opHash,
  className,
}) => {
  const tippyProps = React.useMemo(
    () => ({
      trigger: "mouseenter",
      hideOnClick: false,
      content: "View on block explorer",
      animation: "shift-away-subtle",
    }),
    []
  );

  const ref = useTippy<HTMLAnchorElement>(tippyProps);

  return (
    <a
      ref={ref}
      href={`${baseUrl}/${opHash}`}
      target="_blank"
      rel="noopener noreferrer"
      className={classNames(
        "bg-gray-100 hover:bg-gray-200",
        "rounded-sm shadow-xs",
        "text-xs p-1",
        "text-gray-600 leading-none select-none",
        "transition ease-in-out duration-300",
        "flex items-center",
        className
      )}
    >
      <ArrowRightTopIcon className="w-auto h-3 stroke-current stroke-2" />
    </a>
  );
};

type TimeProps = {
  children: () => React.ReactElement;
};

const Time: React.FC<TimeProps> = ({ children }) => {
  const [value, setValue] = useState(children);

  useEffect(() => {
    const interval = setInterval(() => {
      setValue(children());
    }, 5_000);

    return () => {
      clearInterval(interval);
    };
  }, [setValue, children]);

  return value;
};

function formatOperationType(type: string, imReciever: boolean) {
  if (type === "transaction") {
    type = `${imReciever ? "↓" : "↑"}_${type}`;
  }

  return type
    .split("_")
    .map((w) => `${w.charAt(0).toUpperCase()}${w.substring(1)}`)
    .join(" ");
}

function opKey(op: ThanosOperation) {
  return `${op.hash}_${op.type}`;
}
