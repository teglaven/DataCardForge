import math
import random

def generate_matrix(rows: int = 10000, cols: int = 10) -> list[list[float]]:

    matrix = []
    for r in range(rows):
        base = math.sin(r)  # 正弦值，范围[-1, 1]
        row = [base + random.uniform(-1.0, 1.0) for _ in range(cols)]
        matrix.append(row)
    return matrix

def write_matrix(filename: str, matrix: list[list[float]]) -> None:
    """将矩阵以空格分隔的格式写入文件，所有数字以 double 精度输出。"""
    with open(filename, "w", encoding="utf-8") as f:
        for row in matrix:
            # 使用 repr() 保留完整 double 精度，或 %.15g 保证精度
            f.write(" ".join(f"{x:.15g}" for x in row) + "\n")

def main():
    random.seed(42)  # 使结果可复现（可选）
    matrix = generate_matrix(10000, 10)
    write_matrix("1.txt", matrix)

    random.seed(123)  # 换个种子，生成不同的矩阵
    matrix2 = generate_matrix(10000, 10)
    write_matrix("2.txt", matrix2)

    print("已生成 1.txt 和 2.txt（各 10000 行 × 10 列）")

if __name__ == "__main__":
    main()
