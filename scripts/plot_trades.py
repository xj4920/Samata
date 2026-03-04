#!/usr/bin/env python3
"""
通用交易曲线绘制脚本
用法: python plot_trades.py <client> [limit]
示例: python plot_trades.py Jump 50
"""
import sqlite3
import matplotlib
matplotlib.use('Agg')  # 非交互式后端
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime
import os
import sys

# 设置中文字体
plt.rcParams['font.sans-serif'] = ['SimHei', 'DejaVu Sans', 'Arial Unicode MS', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False

# 数据库路径
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'yanyu.db')

def get_trade_data(client_name, limit=50):
    """从数据库获取交易数据"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT date, client, counter_party, notional_t, trade_amt_ft, ft_net
        FROM trades 
        WHERE client = ?
        ORDER BY date DESC
        LIMIT ?
    """, (client_name.upper(), limit))
    
    rows = cursor.fetchall()
    conn.close()
    
    # 按交易对手分组（按日期升序排列用于绘图）
    data = {}
    
    for row in rows:
        date_str, client, party, notional, trade_amt, ft_net = row
        date = datetime.strptime(str(date_str), '%Y%m%d')
        
        if party not in data:
            data[party] = {'dates': [], 'notional': [], 'trade_amt': [], 'ft_net': []}
        
        # 插入到开头以保持升序
        data[party]['dates'].insert(0, date)
        data[party]['notional'].insert(0, notional / 1e8)
        data[party]['trade_amt'].insert(0, trade_amt / 1e8)
        data[party]['ft_net'].insert(0, ft_net / 1e8)
    
    return data

def plot_charts(client_name, data):
    """绘制曲线图"""
    fig, axes = plt.subplots(3, 1, figsize=(12, 10))
    fig.suptitle(f'{client_name} 历史交易曲线图', fontsize=14, fontweight='bold')
    
    # 使用不同颜色
    colors = ['#2E86AB', '#A23B72', '#F18F01', '#C73E1D', '#3B1F2B']
    color_idx = 0
    
    # 子图1: 存续名义本金
    ax1 = axes[0]
    for party, party_data in data.items():
        if party_data['dates']:
            ax1.plot(party_data['dates'], party_data['notional'], 
                    marker='o', markersize=4, label=party, color=colors[color_idx % len(colors)], linewidth=1.5)
            color_idx += 1
    ax1.set_ylabel('名义本金 (亿元)')
    ax1.set_title('存续名义本金')
    ax1.legend(loc='upper left')
    ax1.grid(True, alpha=0.3)
    ax1.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'))
    
    # 子图2: 成交金额
    color_idx = 0
    ax2 = axes[1]
    for party, party_data in data.items():
        if party_data['dates']:
            ax2.plot(party_data['dates'], party_data['trade_amt'], 
                    marker='s', markersize=4, label=party, color=colors[color_idx % len(colors)], linewidth=1.5)
            color_idx += 1
    ax2.set_ylabel('成交金额 (亿元)')
    ax2.set_title('成交金额')
    ax2.legend(loc='upper left')
    ax2.grid(True, alpha=0.3)
    ax2.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'))
    
    # 子图3: 净头寸
    color_idx = 0
    ax3 = axes[2]
    for party, party_data in data.items():
        if party_data['dates']:
            ax3.plot(party_data['dates'], party_data['ft_net'], 
                    marker='^', markersize=4, label=party, color=colors[color_idx % len(colors)], linewidth=1.5)
            color_idx += 1
    ax3.axhline(y=0, color='gray', linestyle='--', alpha=0.5)
    ax3.set_ylabel('净头寸 (亿元)')
    ax3.set_xlabel('日期')
    ax3.set_title('净头寸 (ft_net)')
    ax3.legend(loc='upper left')
    ax3.grid(True, alpha=0.3)
    ax3.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'))
    
    plt.tight_layout()
    
    # 保存图片
    output_dir = os.path.join(os.path.dirname(__file__), '..', 'data')
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f'{client_name.lower()}_history.png')
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()
    
    return output_path

def main():
    if len(sys.argv) < 2:
        print("用法: python plot_trades.py <client> [limit]")
        print("示例: python plot_trades.py Jump 50")
        sys.exit(1)
    
    client_name = sys.argv[1].upper()
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    
    print(f"正在获取 {client_name} 交易数据 (最多 {limit} 条)...")
    data = get_trade_data(client_name, limit)
    
    if not data:
        print(f"未找到 {client_name} 的交易数据")
        sys.exit(1)
    
    parties = list(data.keys())
    print(f"获取到交易对手: {', '.join(parties)}")
    for party in parties:
        print(f"  - {party}: {len(data[party]['dates'])} 条记录")
    
    print("\n正在绘制曲线图...")
    output_path = plot_charts(client_name, data)
    print(f"✅ 图表已保存至: {output_path}")

if __name__ == '__main__':
    main()
